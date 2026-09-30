import './markdown.js';

// Use the same escaped HTML and HTTP(S)-only links as final chat messages.
const markdown = globalThis.window?.webchatMarkdown || globalThis.webchatMarkdown;

export function renderLogMarkdown(container, text) {
    container.innerHTML = markdown.render(String(text || ''));
}
