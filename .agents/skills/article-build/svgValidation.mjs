import { readFile } from 'node:fs/promises';

function parseAttributes(tag) {
  const attributes = {};

  for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }

  return attributes;
}

function parseViewBox(svg) {
  const match = svg.match(/viewBox="([^"]+)"/);

  if (!match) {
    throw new Error('SVG is missing a viewBox.');
  }

  const values = match[1].split(/\s+/).map(Number);

  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('SVG has an invalid viewBox.');
  }

  const [, , width, height] = values;

  return { width, height };
}

function parseRects(svg) {
  return [...svg.matchAll(/<rect\b[^>]*>/g)].map((match) => {
    const attributes = parseAttributes(match[0]);

    return {
      x: Number(attributes.x ?? 0),
      y: Number(attributes.y ?? 0),
      width: Number(attributes.width ?? 0),
      height: Number(attributes.height ?? 0),
      stroke: attributes.stroke ?? ''
    };
  });
}

function parseTexts(svg) {
  return [...svg.matchAll(/<text\b([^>]*)>(.*?)<\/text>/gs)].map((match) => {
    const attributes = parseAttributes(match[1]);

    return {
      x: Number(attributes.x ?? 0),
      y: Number(attributes.y ?? 0),
      fontSize: Number(attributes['font-size'] ?? 16),
      text: match[2].replace(/<[^>]+>/g, '').trim(),
      textAnchor: attributes['text-anchor'] ?? 'start'
    };
  });
}

function parsePathEndpoints(d) {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

  if (numbers.length < 4 || numbers.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return {
    start: { x: numbers[0], y: numbers[1] },
    end: { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] }
  };
}

function parsePaths(svg) {
  return [...svg.matchAll(/<path\b[^>]*>/g)].map((match) => {
    const attributes = parseAttributes(match[0]);
    const d = attributes.d ?? '';

    return {
      d,
      endpoints: parsePathEndpoints(d)
    };
  });
}

function parseCircles(svg) {
  return [...svg.matchAll(/<circle\b[^>]*>/g)].map((match) => {
    const attributes = parseAttributes(match[0]);

    return {
      cx: Number(attributes.cx ?? 0),
      cy: Number(attributes.cy ?? 0),
      r: Number(attributes.r ?? 0)
    };
  });
}

function parseLines(svg) {
  return [...svg.matchAll(/<line\b[^>]*>/g)].map((match) => {
    const attributes = parseAttributes(match[0]);

    return {
      x1: Number(attributes.x1 ?? 0),
      y1: Number(attributes.y1 ?? 0),
      x2: Number(attributes.x2 ?? 0),
      y2: Number(attributes.y2 ?? 0)
    };
  });
}

function rectanglesOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function rectContainsRect(container, box, padding = 0) {
  return (
    box.x >= container.x + padding &&
    box.y >= container.y + padding &&
    box.x + box.width <= container.x + container.width - padding &&
    box.y + box.height <= container.y + container.height - padding
  );
}

function textBox(textNode) {
  const width = Math.max(14, textNode.text.length * textNode.fontSize * 0.48);
  const height = Math.max(14, textNode.fontSize * 1.2);
  const x =
    textNode.textAnchor === 'middle'
      ? textNode.x - width / 2
      : textNode.textAnchor === 'end'
        ? textNode.x - width
        : textNode.x;

  return {
    x,
    y: textNode.y - height,
    width,
    height
  };
}

function pointNearRectBoundary(point, rect, tolerance = 18) {
  const withinVertical = point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance;
  const withinHorizontal = point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance;
  const nearLeft = Math.abs(point.x - rect.x) <= tolerance && withinVertical;
  const nearRight = Math.abs(point.x - (rect.x + rect.width)) <= tolerance && withinVertical;
  const nearTop = Math.abs(point.y - rect.y) <= tolerance && withinHorizontal;
  const nearBottom = Math.abs(point.y - (rect.y + rect.height)) <= tolerance && withinHorizontal;

  return nearLeft || nearRight || nearTop || nearBottom;
}

function validateFiniteAndBounds(values, width, height, label) {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite coordinate.`);
    }
  }

  for (let index = 0; index < values.length; index += 2) {
    const x = values[index];
    const y = values[index + 1];

    if (x !== undefined && (x < -5 || x > width + 5 || y < -5 || y > height + 5)) {
      throw new Error(`${label} is out of bounds.`);
    }
  }
}

function validateTextOverlap(texts, width, height) {
  for (let index = 0; index < texts.length; index += 1) {
    const first = textBox(texts[index]);
    validateFiniteAndBounds([first.x, first.y, first.x + first.width, first.y + first.height], width, height, 'text');

    for (let second = index + 1; second < texts.length; second += 1) {
      const other = textBox(texts[second]);
      const sameBand = Math.abs(first.y - other.y) < Math.max(first.height, other.height);

      if (sameBand && rectanglesOverlap(first, other)) {
        throw new Error('Text labels overlap.');
      }
    }
  }
}

function validateBasicFigure(svg) {
  const { width, height } = parseViewBox(svg);
  const rects = parseRects(svg);
  const lines = parseLines(svg);
  const circles = parseCircles(svg);
  const paths = parsePaths(svg).filter((path) => path.endpoints);
  const texts = parseTexts(svg).filter((textNode) => textNode.text);

  for (const rect of rects) {
    validateFiniteAndBounds([rect.x, rect.y, rect.x + rect.width, rect.y + rect.height], width, height, 'rect');

    if (rect.width < 0 || rect.height < 0) {
      throw new Error('Figure contains a negative-size rectangle.');
    }
  }

  for (const line of lines) {
    validateFiniteAndBounds([line.x1, line.y1, line.x2, line.y2], width, height, 'line');
  }

  for (const circle of circles) {
    validateFiniteAndBounds([circle.cx, circle.cy], width, height, 'circle');

    if (circle.r <= 0 || !Number.isFinite(circle.r)) {
      throw new Error('Figure contains an invalid circle radius.');
    }
  }

  for (const path of paths) {
    validateFiniteAndBounds(
      [path.endpoints.start.x, path.endpoints.start.y, path.endpoints.end.x, path.endpoints.end.y],
      width,
      height,
      'path'
    );
  }

  validateTextOverlap(texts, width, height);
}

function validateConceptFigure(svg, expectedRects, expectedConnectorCount) {
  const { width, height } = parseViewBox(svg);
  const rects = parseRects(svg).filter((rect) => rect.width > 120 && rect.height > 60 && rect.stroke && rect.stroke !== 'none');
  const texts = parseTexts(svg).filter((textNode) => textNode.fontSize >= 14);
  const paths = parsePaths(svg).filter((path) => path.endpoints);

  if (rects.length !== expectedRects) {
    throw new Error(`Expected ${expectedRects} major rectangles, found ${rects.length}.`);
  }

  for (const rect of rects) {
    validateFiniteAndBounds([rect.x, rect.y, rect.x + rect.width, rect.y + rect.height], width, height, 'rectangle');
  }

  for (let index = 0; index < rects.length; index += 1) {
    for (let second = index + 1; second < rects.length; second += 1) {
      if (rectanglesOverlap(rects[index], rects[second])) {
        throw new Error('Major rectangles overlap.');
      }
    }
  }

  const connectors = paths.filter((path) =>
    rects.some((rect) => pointNearRectBoundary(path.endpoints.start, rect)) &&
    rects.some((rect) => pointNearRectBoundary(path.endpoints.end, rect))
  );

  if (connectors.length < expectedConnectorCount) {
    throw new Error('At least one connector does not attach to a figure node.');
  }

  for (const textNode of texts) {
    const box = textBox(textNode);
    validateFiniteAndBounds([box.x, box.y, box.x + box.width, box.y + box.height], width, height, 'text');

    if (textNode.y > 60 && !rects.some((rect) => rectContainsRect(rect, box, 6))) {
      throw new Error('Concept-figure text escapes its container.');
    }
  }

  validateTextOverlap(texts, width, height);
}

function validateChartFigure(svg) {
  validateBasicFigure(svg);

  const texts = parseTexts(svg).filter((textNode) => textNode.y >= 10);

  if (texts.some((textNode) => textNode.fontSize >= 16 && textNode.y < 34)) {
    throw new Error('Chart titles must not be embedded inside SVG files.');
  }
}

async function validateSvgFile(filePath, rule = { type: 'generic' }) {
  const svg = await readFile(filePath, 'utf8');
  const type = rule?.type ?? 'generic';

  if (type === 'concept') {
    validateConceptFigure(svg, rule.expectedRects, rule.expectedConnectorCount);
  } else if (type === 'chart') {
    validateChartFigure(svg);
  } else {
    validateBasicFigure(svg);
  }

  return {
    filePath,
    status: 'valid',
    ruleType: type
  };
}

export { validateSvgFile };
