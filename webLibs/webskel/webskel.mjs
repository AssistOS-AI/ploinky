class L {
  constructor() {
    this.loadedStyleSheets = /* @__PURE__ */ new Map(), this.components = {};
  }
  async loadStyleSheets(e, t) {
    const n = [];
    return n.push(...e.map((o) => this.loadStyleSheet({
      cssText: o,
      identifier: t
    }))), (await Promise.all(n)).join("");
  }
  async loadStyleSheet({ url: e = null, cssText: t = null, identifier: n = null }) {
    if (!e && !t)
      return;
    const o = n || e;
    let i = this.loadedStyleSheets.get(o) || 0;
    if (i === 0)
      return new Promise((s, a) => {
        try {
          const l = document.createElement("style");
          l.textContent = t, n && (l.className = n), document.head.appendChild(l), this.loadedStyleSheets.set(o, i + 1), s(l.outerHTML);
        } catch (l) {
          a(new Error(`Failed to inject the CSS text: ${l.message}`));
        }
      });
    this.loadedStyleSheets.set(o, i + 1);
  }
  async unloadStyleSheets(e) {
    let t = this.loadedStyleSheets.get(e);
    t !== void 0 && (t -= 1, t <= 0 ? (this.removeStyleSheet(e), this.loadedStyleSheets.delete(e)) : this.loadedStyleSheets.set(e, t));
  }
  removeStyleSheet(e) {
    Array.from(document.head.querySelectorAll(`link[class="${e}"], style[class="${e}"]`)).forEach((n) => document.head.removeChild(n));
  }
  async loadComponent(e) {
    if (this.components[e.name]) {
      if (this.components[e.name].isPromiseFulfilled)
        return await this.loadStyleSheets(this.components[e.name].css, e.name), {
          html: this.components[e.name].html,
          css: this.components[e.name].css
        };
      {
        let t = await this.components[e.name].loadingPromise;
        return await this.loadStyleSheets(t.css, e.name), t;
      }
    } else return this.components[e.name] = {
      html: "",
      css: [],
      presenter: null,
      loadingPromise: null,
      isPromiseFulfilled: !1
    }, this.components[e.name].loadingPromise = (async () => {
      function t(n, o) {
        const { rootDir: i, webComponentsRootDir: s } = h.instance.configs;
        let a = i || s || "";
        return n.directory && (a = `${a}/${n.directory}`), a || (a = s ? `./${s}${n.directory ? `/${n.directory}` : ""}` : `${n.directory ? `/${n.directory}` : ""}`), `${a}/${n.type}/${n.name}/${n.name}.${o}`;
      }
      try {
        let n, o;
        n = t(e, "html"), o = t(e, "css");
        const i = e.loadedTemplate || await (await fetch(n)).text();
        this.components[e.name].html = i;
        const s = e.loadedCSSs || [await (await fetch(o)).text()];
        if (this.components[e.name].css = s, await this.loadStyleSheets(s, e.name), e.presenterClassName)
          if (e.presenterModule)
            this.registerPresenter(e.name, e.presenterModule[e.presenterClassName]);
          else {
            const l = await import(t(e, "js"));
            this.registerPresenter(e.name, l[e.presenterClassName]);
          }
        return this.components[e.name].isPromiseFulfilled = !0, { html: i, css: s };
      } catch (n) {
        throw n;
      }
    })();
  }
  registerPresenter(e, t) {
    this.components[e].presenter = t;
  }
  initialisePresenter(e, t, n, o = {}) {
    let i;
    try {
      i = new this.components[t.componentName].presenter(t, n, o), t.isPresenterReady = !0, t.onPresenterReady();
    } catch (s) {
      showApplicationError("Error creating a presenter instance", `Encountered an error during the initialization of ${e} for component: ${t.componentName}`, s + ":" + s.stack.split(`
`)[1]);
    }
    return i;
  }
  async waitForDescendantRenders(e) {
    await Promise.resolve();
    const t = [...e.querySelectorAll("[data-presenter]")].filter((n) => n !== e);
    const o = t.map((n) => n.renderCompletePromise).filter((n) => n && typeof n.then == "function");
    o.length && await Promise.allSettled(o);
  }
}
function $(r) {
  if (!r) {
    console.error("moveCursorToEnd: No element provided");
    return;
  }
  if (document.activeElement !== r && r.focus(), typeof window.getSelection < "u" && typeof document.createRange < "u") {
    const e = document.createRange();
    e.selectNodeContents(r), e.collapse(!1);
    const t = window.getSelection();
    t.removeAllRanges(), t.addRange(e);
  } else if (typeof document.body.createTextRange < "u") {
    const e = document.body.createTextRange();
    e.moveToElementText(r), e.collapse(!1), e.select();
  }
}
function g(r, e, t) {
  let n = null;
  for (; r; ) {
    if (r.matches(e)) {
      n = r;
      break;
    } else if (t && r.matches(t))
      break;
    r = r.parentElement;
  }
  return n;
}
function w(r, e, t = "", n = !1) {
  const o = /* @__PURE__ */ new Set();
  if (!(r instanceof Element))
    throw new TypeError("The first argument must be a DOM Element.");
  if (typeof e != "string" || e.trim() === "")
    throw new TypeError("The second argument must be a non-empty string.");
  if (r.matches(e) && !n)
    return r;
  o.add(r);
  let i = r;
  for (; i; ) {
    const s = i.parentElement;
    if (s) {
      let a = s.firstElementChild;
      for (; a; ) {
        if (!o.has(a)) {
          if (o.add(a), a !== i && a.matches(e))
            return a;
          if (a.children.length > 0) {
            const l = [a.firstElementChild];
            for (; l.length > 0; ) {
              const d = l.shift();
              if (!o.has(d)) {
                if (o.add(d), d.matches(e))
                  return d;
                let c = d.nextElementSibling;
                for (; c; )
                  l.push(c), c = c.nextElementSibling;
                d.firstElementChild && l.push(d.firstElementChild);
              }
            }
          }
        }
        a = a.nextElementSibling;
      }
    }
    if (i = s, i && !o.has(i)) {
      if (o.add(i), i.matches(e))
        return i;
      if (t && i.matches(t))
        break;
    }
  }
  return null;
}
function A(r) {
  const e = (r.match(/\//g) || []).length;
  return !(e > 1 || e === 1 && r.charAt(r.length - 1) !== "/");
}
function R(r) {
  return r != null && typeof r == "string" ? r.replace(/&nbsp;/g, " ").replace(/&#13;/g, `
`).replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
}
function y(r) {
  return r != null && typeof r == "string" ? r.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r\n/g, "&#13;").replace(/[\r\n]/g, "&#13;").replace(/\s/g, "&nbsp;") : r;
}
function M(r) {
  return r != null && typeof r == "string" ? r.replace(/\u00A0/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : r;
}
function T(r) {
  return r.replace(/^[\u00A0\s]+|[\u00A0\s]+$/g, "").trim();
}
function O(r) {
  return g(r, ".app-container");
}
function b(r, e) {
  if (!r || !(r instanceof HTMLElement))
    return console.error("getClosestParentWithPresenter: Invalid or no element provided"), null;
  const t = e ? `[data-presenter="${e}"]` : "[data-presenter]";
  return w(r, t, "", !0);
}
function j(r) {
  if (!r || !(r instanceof HTMLElement))
    return console.error("invalidateParentElement: Invalid or no element provided"), null;
  E(b(r));
}
function E(r) {
  if (!r || !(r instanceof HTMLElement)) {
    console.error("refreshElement: Invalid or no element provided");
    return;
  }
  if (!r.webSkelPresenter || typeof r.webSkelPresenter.invalidate != "function") {
    console.error("refreshElement: Element does not have a webSkelPresenter with an invalidate method");
    return;
  }
  r.webSkelPresenter.invalidate();
}
const N = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  customTrim: T,
  getClosestParentElement: g,
  getClosestParentWithPresenter: b,
  getMainAppContainer: O,
  invalidateParentElement: j,
  moveCursorToEnd: $,
  normalizeSpaces: M,
  notBasePage: A,
  refreshElement: E,
  reverseQuerySelector: w,
  sanitize: y,
  unsanitize: R
}, Symbol.toStringTag, { value: "Module" }));
async function _(r, e) {
  const t = g(r, "form"), n = {
    data: {},
    elements: {},
    isValid: !1
  };
  typeof t.checkValidity == "function" && (n.isValid = t.checkValidity());
  const o = [...t.querySelectorAll("[name]:not([type=hidden])")];
  for (const i of o) {
    if (i.disabled)
      continue;
    if (i.multiple && i.tagName === "SELECT" ? n.data[i.name] = Array.from(i.selectedOptions).map((l) => l.value) : n.data[i.name] = i.tagName === "CHECKBOX" || i.tagName === "INPUT" && i.type === "checkbox" ? i.checked : i.value, i.getAttribute("type") === "file")
      if (i.multiple)
        n.data[i.name] = i.files;
      else
        try {
          i.files.length > 0 && (n.data[i.name] = await P(i.files[0]));
        } catch (l) {
          console.log(l);
        }
    let s = !0;
    if (i.setCustomValidity(""), typeof i.checkValidity == "function" ? s = i.checkValidity() : typeof i.getInputElement == "function" && (s = (await i.getInputElement()).checkValidity()), s === !0 && e) {
      let l = i.getAttribute("data-condition");
      l && (s = e[l].fn(i, n), s ? i.setCustomValidity("") : (i.setCustomValidity(e[l].errorMessage), n.isValid = !1));
    }
    n.elements[i.name] = {
      isValid: s,
      element: i
    };
    let a = document.querySelector(`[data-id = '${i.getAttribute("id")}' ]`);
    a && (s ? a.classList.remove("input-invalid") : a.classList.add("input-invalid"));
  }
  t.checkValidity() || t.reportValidity();
  for (let i of Object.keys(n.data))
    n.elements[i] && n.elements[i].element && n.elements[i].element.hasAttribute("data-no-sanitize") || (n.data[i] = y(n.data[i]));
  return n;
}
async function P(r) {
  let e = "", t = new FileReader();
  return await new Promise((n, o) => {
    t.onload = function() {
      e = t.result, n(e);
    }, r ? t.readAsDataURL(r) : o("No file given as input at imageUpload");
  });
}
async function U(r) {
  let e = "", t = new FileReader();
  return await new Promise((n, o) => {
    t.onload = function() {
      e = t.result, n(e);
    }, r ? t.readAsText(r) : o("No file given as input");
  });
}
const V = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  extractFormInformation: _,
  imageUpload: P,
  uploadFileAsText: U
}, Symbol.toStringTag, { value: "Module" }));
async function S(r, e, t) {
  typeof e == "boolean" && (t = e, e = void 0);
  const n = document.querySelector("body"), o = g(n, "dialog");
  o && (o.close(), o.remove());
  const i = Object.assign(F(r, e), {
    component: r,
    cssClass: r,
    componentProps: e
  });
  return n.appendChild(i), await i.showModal(), i.addEventListener("keydown", v), t ? new Promise((s) => {
    i.addEventListener("close", (a) => {
      s(a.data);
    });
  }) : i;
}
function v(r) {
  r.key === "Escape" && r.preventDefault();
}
function F(r, e) {
  let t = document.createElement("dialog"), n = "";
  return e !== void 0 && Object.keys(e).forEach((i) => {
    n += ` data-${i}="${e[i]}"`;
  }), h.instance.configs.components.find((i) => i.name === r).presenterClassName && (n += ` data-presenter="${r}"`), n === "" ? t.innerHTML = `<${r}/>` : t.innerHTML = `<${r}${n}/>`, t.classList.add("modal", `${r}-dialog`), t;
}
function H(r, e) {
  const t = g(r, "dialog");
  if (e !== void 0) {
    let n = new Event("close", {
      bubbles: !0,
      cancelable: !0
    });
    n.data = e, t.dispatchEvent(n);
  }
  t && (t.close(), t.remove());
}
function C(r, e) {
  document.removeEventListener("click", r.clickHandler), r.remove(), e !== void 0 && delete e.actionBox;
}
async function I(r, e, t, n, o = {}) {
  if (r.parentNode.querySelector(t))
    return null;
  const s = document.createElement(`${t}`);
  for (const [d, c] of Object.entries(o))
    s.setAttribute(`data-${d}`, c);
  let a;
  switch (n) {
    case "prepend":
      r.parentNode.insertBefore(s, r);
      break;
    case "append":
      r.parentNode.appendChild(s);
      break;
    case "replace":
      a = r;
      const d = a.parentNode;
      d.removeChild(a), d.appendChild(s);
      break;
    case "replace-all":
      a = r.parentNode;
      const c = a;
      a = c.innerHTML, c.innerHTML = "", c.appendChild(s);
      break;
    default:
      console.error(`Invalid Insertion Mode: ${n}. No changes to the DOM have been made`);
      return;
  }
  let l = (d) => {
    if (s && !s.contains(d.target)) {
      if (n === "replace" && a) {
        const c = s.parentNode;
        c.removeChild(s), c.appendChild(a);
      } else if (n === "replace-all" && a) {
        const c = s.parentNode;
        c.innerHTML = a;
      }
      C(s);
    }
  };
  return s.clickHandler = l, document.addEventListener("click", l), s;
}
async function D(r, e, t = !1) {
  typeof e == "boolean" && (t = e, e = void 0);
  const n = document.querySelector("body"), o = g(n, "dialog");
  o && (o.close(), o.remove());
  let i = document.createElement("dialog");
  i.classList.add("modal", `${r}-dialog`);
  const s = window.WebSkel || assistOS.UI;
  if (!s)
    throw new Error("WebSkel instance not found for reactive modal");
  let a = s.configs.components.find((c) => c.name === r);
  const l = s.createElement(
    r,
    i,
    e || {},
    a?.presenterClassName ? { "data-presenter": r } : {},
    !0
  );
  Object.assign(i, {
    component: r,
    cssClass: r,
    componentProps: e,
    _componentProxy: l
  });
  const d = new Proxy(i, {
    get(c, f) {
      return f === "props" ? l : Reflect.get(c, f);
    }
  });
  return n.appendChild(i), await i.showModal(), i.addEventListener("keydown", v), t ? new Promise((c) => {
    i.addEventListener("close", (f) => {
      c(f.data);
    });
  }) : d;
}
const B = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  closeModal: H,
  createReactiveModal: D,
  removeActionBox: C,
  showActionBox: I,
  showModal: S
}, Symbol.toStringTag, { value: "Module" }));
function k(r) {
  let e = /\$\$[\w\-_]+/g;
  return r.match(e) || [];
}
function x(r) {
  let e = 0;
  const t = 0, n = 1;
  function o(l) {
    return !/^[a-zA-Z0-9_\-$]$/.test(l);
  }
  function i(l) {
    return r[l] !== "$" || r[l + 1] !== "$" ? t : n;
  }
  let s = [], a = 0;
  for (; a < r.length; ) {
    for (; !i(a) && a < r.length; )
      a++;
    for (s.push(r.slice(e, a)), e = a; !o(r[a]) && a < r.length; )
      a++;
    s.push(r.slice(e, a)), e = a;
  }
  return s;
}
function q(r, e) {
  if (typeof r != "string" || r.trim() === "")
    throw new Error("Input data must be a non-empty string.");
  if (typeof e != "string" || e.trim() === "")
    throw new Error("MIME type must be a non-empty string.");
  try {
    return `data:${e};base64,` + window.btoa(r);
  } catch (t) {
    throw console.error("Error encoding data to Base64:", t), new Error("Failed to encode data to Base64.");
  }
}
function z(r) {
  if (typeof r != "string")
    throw new Error("Input must be a Base64 encoded string.");
  let e = r.split(","), t = e[0].startsWith("data:") ? e[1] : e[0];
  if (!t)
    throw new Error("Invalid Base64 data format.");
  try {
    return atob(t);
  } catch (n) {
    throw console.error("Error decoding Base64 string:", n), new Error("Failed to decode Base64 string.");
  }
}
const K = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  createTemplateArray: x,
  decodeBase64: z,
  encodeToBase64: q,
  findDoubleDollarWords: k
}, Symbol.toStringTag, { value: "Module" }));
function Q() {
  let r = navigator.userAgent, e, t = r.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) || [];
  return /trident/i.test(t[1]) ? (e = /\brv[ :]+(\d+)/g.exec(r) || [], { name: "IE", version: e[1] || "" }) : t[1] === "Chrome" && (e = r.match(/\bOPR|Edge\/(\d+)/), e != null) ? { name: "Opera", version: e[1] } : (t = t[2] ? [t[1], t[2]] : [navigator.appName, navigator.appVersion, "-?"], (e = r.match(/version\/(\d+)/i)) != null && t.splice(1, 1, e[1]), {
    name: t[0],
    version: t[1]
  });
}
function X() {
  const r = window.location.search, e = new URLSearchParams(r);
  let t = {};
  for (let n of e.keys())
    t[n] = e.get(n);
  return t;
}
function Z() {
  const r = window.location.hash.split("?");
  let e = {};
  if (r[1]) {
    const t = new URLSearchParams(r[1]);
    for (const [n, o] of t)
      e[n] = o;
    return e;
  }
  return e;
}
const G = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  getBrowser: Q,
  getHashParams: Z,
  getURLParams: X
}, Symbol.toStringTag, { value: "Module" }));
class h {
  constructor() {
    this._appContent = {}, this.appServices = {}, this._documentElement = document, this.actionRegistry = {}, this.registerListeners(), this.ResourceManager = new L(), this.defaultLoader = document.createElement("dialog"), this.loaderCount = 0, this.activeLoaderId = null, this.defaultLoader.classList.add("spinner"), this.defaultLoader.classList.add("spinner-default-style"), window.showApplicationError = async (e, t, n) => await S("show-error-modal", {
      title: e,
      message: t,
      technical: n
    }), console.log("creating new app manager instance");
  }
  async reinit(e) {
    await h.instance.loadConfigs(e);
  }
  static async initialise(e) {
    if (h.instance)
      return h.instance;
    let t = new h();
    window.webSkel = t;
    const n = [
      N,
      V,
      B,
      K,
      G
    ];
    for (const o of n)
      for (const [i, s] of Object.entries(o))
        t[i] = s;
    return await t.loadConfigs(e), h.instance = t, h.instance;
  }
  async loadConfigs(e) {
    try {
      const n = await (await fetch(e)).json();
      this.configs = n;
      for (const o of n.components)
        await this.defineComponent(o);
    } catch (t) {
      console.error(t), await window.showApplicationError("Error loading configs", "Error loading configs", `Encountered ${t} while trying loading webSkel configs`);
    }
  }
  showLoading() {
    const t = this.activeLoaderId || crypto.randomUUID();
    if (this.loaderCount === 0) {
      let e = this.defaultLoader.cloneNode(!0);
      e.setAttribute("data-id", t);
      document.body.appendChild(e);
      e.showModal();
      this.activeLoaderId = t;
      this.loaderCount = 1;
      return t;
    }
    this.loaderCount++;
    return this.activeLoaderId;
  }
  clearLoading() {
    document.querySelectorAll(".spinner").forEach((e) => {
      e.close(), e.remove();
    });
    this.loaderCount = 0;
    this.activeLoaderId = null;
  }
  hideLoading(e) {
    if (this.loaderCount <= 0) {
      this.clearLoading();
      return;
    }
    if (this.loaderCount > 1) {
      this.loaderCount--;
      return;
    }
    const t = this.activeLoaderId || e;
    if (t) {
      let n = document.querySelector(`[data-id = '${t}' ]`);
      if (n) {
        n.close(), n.remove();
      } else {
        this.clearLoading();
        return;
      }
    } else
      this.clearLoading();
    this.loaderCount = 0;
    this.activeLoaderId = null;
  }
  setLoading(e) {
    this.defaultLoader.innerHTML = e, this.defaultLoader.classList.remove("spinner-default-style");
  }
  resetLoading() {
    this.defaultLoader = document.createElement("dialog"), this.defaultLoader.classList.add("spinner"), this.defaultLoader.classList.add("spinner-default-style");
  }
  async changeToDynamicPage(e, t, n, o) {
    try {
      this.validateTagName(e);
    } catch (a) {
      await window.showApplicationError(`Failed to navigate to ${e} with Url ${t}`, a.message, a.stack.toString()), console.error(a);
      return;
    }
    const i = this.showLoading();
    let s = "";
    n && (s = Object.entries(n).map(([a, l]) => `data-${a}="${l}"`).join(" "));
    try {
      const a = `<${e} data-presenter="${e}" ${s}></${e}>`;
      if (!o) {
        const l = ["#", t].join("");
        window.history.pushState({ pageHtmlTagName: e, relativeUrlContent: a }, l.toString(), l);
      }
      await this.updateAppContent(a);
      const child = this._appContent.querySelector(e);
      if (child && child.renderCompletePromise) {
        await child.renderCompletePromise;
      }
    } catch (a) {
      console.error("Failed to change page", a);
      await window.showApplicationError("Failed to change page", a.message || "Failed to change page.", a.stack || String(a));
    } finally {
      this.hideLoading(i);
    }
  }
  validateTagName(e) {
    if (!/^(?![0-9])[a-z0-9]+(?:-*[a-z0-9]+)*-*?$/.test(e))
      throw new Error(`Invalid tag name: ${e}`);
    if (!this.configs.components.find((o) => o.name === e))
      throw new Error(`Element not found in configs: ${e}`);
  }
  async changeToStaticPage(e, t) {
    const n = this.showLoading();
    try {
      const o = await this.fetchTextResult(e, t);
      await this.updateAppContent(o);
      const children = this._appContent.querySelectorAll('[data-presenter]');
      const promises = Array.from(children).map(c => c.renderCompletePromise).filter(Boolean);
      if (promises.length) {
        await Promise.all(promises);
      }
    } catch (o) {
      console.error("Failed to change page", o);
      await window.showApplicationError("Failed to change page", o.message || "Failed to change page.", o.stack || String(o));
    } finally {
      this.hideLoading(n);
    }
  }
  async interceptAppContentLinks(e) {
    let t = e.target || e.srcElement;
    if (t.hasAttribute("data-page")) {
      let n = t.getAttribute("data-page");
      return e.preventDefault(), await this.changeToDynamicPage(n);
    }
    if (t.hasAttribute("data-path")) {
      let n = t.getAttribute("data-path");
      return e.preventDefault(), await this.changeToStaticPage(n);
    }
  }
  setDomElementForPages(e) {
    this._appContent = e;
  }
  async updateAppContent(e) {
    try {
      this.preventExternalResources(e);
    } catch (t) {
      await window.showApplicationError("UpdateAppContent", t.message, t.stack.toString()), console.error(t);
      return;
    }
    this._appContent.innerHTML = e;
  }
  preventExternalResources(e) {
    let t = /(src|href|action|onclick)\s*=\s*"[^"]*"/g, n = e.match(t);
    if (n)
      for (let o of n) {
        let i = o.split('"')[1], s = new URL(i).host;
        if (window.location.host !== s)
          throw new Error(`External resource detected: ${i}`);
      }
  }
  registerListeners() {
    this._documentElement.addEventListener("click", this.interceptAppContentLinks.bind(this)), window.onpopstate = async (e) => {
      const hash = window.location.hash;
      if (hash) {
        const hashContent = hash.substring(1);
        const pageName = hashContent.split("/")[0].split("?")[0];
        const knownPage = this.configs.components.find((c) => c.name === pageName);
        if (knownPage) {
          const existing = this._appContent.querySelector(pageName);
          if (existing && existing.webSkelPresenter) {
            return;
          }
          await this.changeToDynamicPage(pageName, hashContent, null, true);
          return;
        }
      }
      if (e.state && e.state.relativeUrlContent) {
        await this.updateAppContent(e.state.relativeUrlContent);
        const children = this._appContent.querySelectorAll('[data-presenter]');
        const promises = Array.from(children).map(c => c.renderCompletePromise).filter(Boolean);
        if (promises.length) {
          await Promise.all(promises);
        }
      }
    }, this._documentElement.addEventListener("click", async (e) => {
      let t = e.target, n = !1;
      for (; t && t !== this._documentElement && !n; ) {
        if (t.hasAttribute("data-local-action")) {
          e.preventDefault(), e.stopPropagation(), n = !0;
          let o = t, i = !1;
          const s = t.getAttribute("data-local-action"), [a, ...l] = s.split(" ");
          for (; i === !1; ) {
            let d = !1, c;
            for (; d === !1; ) {
              if (o.webSkelPresenter) {
                d = !0, c = o.webSkelPresenter;
                break;
              }
              if (o = o.parentElement, o === document) {
                await window.showApplicationError("Error executing action", "Action not found in any Presenter", "Action not found in any Presenter");
                return;
              }
            }
            if (c[a] !== void 0)
              try {
                o.webSkelPresenter[a](t, ...l), i = !0;
              } catch (f) {
                console.error(f), await window.showApplicationError("Error executing action", "There is no action for the button to execute", `Encountered ${f}`);
                return;
              }
            else
              d = !1, o = o.parentElement;
          }
        } else if (t.hasAttribute("data-action")) {
          e.preventDefault(), e.stopPropagation(), n = !0;
          const o = t.getAttribute("data-action"), [i, ...s] = o.split(" ");
          i ? this.callAction(i, t, ...s) : console.error(`${t} : data action attribute value should not be empty!`);
          break;
        }
        t = t.parentElement;
      }
    });
  }
  registerAction(e, t) {
    this.actionRegistry[e] = t;
  }
  callAction(e, ...t) {
    const n = this.actionRegistry[e];
    if (!n)
      throw new Error(`No action handler registered for "${e}"`);
    let o = t && t[0] instanceof HTMLElement ? t[0] : null;
    n.call(o, ...t);
  }
  async fetchTextResult(e, t) {
    const n = new URL(`${window.location.protocol}//${window.location.host}`);
    e.startsWith("#") && (e = e.slice(1)), console.log("Fetching Data from URL: ", n + e);
    const o = await fetch(n + e);
    if (!o.ok)
      throw new Error("Failed to execute request");
    const i = await o.text();
    if (!t) {
      const s = n + "#" + e;
      window.history.pushState({ relativeUrlPath: e, relativeUrlContent: i }, s.toString(), s);
    }
    return i;
  }
  /**
   * Creates a custom element with reactive properties.
   * @param {string} elementName - The tag name of the custom element.
   * @param {HTMLElement|string|null} [location=null] - The parent element or a selector where the element will be appended.
   * @param {Object} [attributes={}] - An object containing attributes to set on the element.
   * @param {Object} [props={}] - An object containing initial properties for reactive proxying.
   * @param {boolean} [observeProps=false] - If true, nested objects in props will be observed.
   * @returns {Proxy} A reactive proxy for the element's properties.
   */
  createElement(e, t = null, n = {}, o = {}, i = !1) {
    const s = document.createElement(e), { proxy: a, revoke: l } = this.createReactiveProxy(n, i, s);
    s.setAttribute("data-presenter", e);
    const d = {
      get(f, u, p) {
        if (u === "element")
          return new WeakRef(s);
        if (u in a)
          return Reflect.get(a, u, p);
        if (u in s) {
          const m = s[u];
          return typeof m == "function" ? m.bind(s) : m;
        }
        return Reflect.get(f, u, p);
      },
      set(f, u, p, m) {
        return u === "element" ? !1 : u in a ? Reflect.set(a, u, p, m) : u in s ? (s[u] = p, !0) : Reflect.set(a, u, p, m);
      },
      has(f, u) {
        return u === "element" || u in a || u in s;
      },
      ownKeys(f) {
        const u = Reflect.ownKeys(a), p = Reflect.ownKeys(s);
        return [.../* @__PURE__ */ new Set([...u, ...p, "element"])];
      },
      getOwnPropertyDescriptor(f, u) {
        return u === "element" ? {
          value: new WeakRef(s),
          writable: !1,
          enumerable: !0,
          configurable: !1
        } : u in a ? Reflect.getOwnPropertyDescriptor(a, u) : u in s ? Reflect.getOwnPropertyDescriptor(s, u) : Reflect.getOwnPropertyDescriptor(f, u);
      }
    }, c = new Proxy({}, d);
    return s._webSkelProps = {
      raw: n,
      proxy: a,
      revoke: l,
      observeProps: i
    }, Object.entries(o).forEach(([f, u]) => {
      s.setAttribute(f, u);
    }), t instanceof HTMLElement ? t?.appendChild(s) : typeof t == "string" && document.querySelector(t)?.appendChild(s), c;
  }
  /**
   * Creates a reactive proxy for an object that triggers an element invalidation on property changes.
   * @param {Object} target - The target object to wrap in a reactive proxy.
   * @param {boolean} observe - If true, nested objects are also wrapped in reactive proxies.
   * @param {HTMLElement} element - The element whose invalidate method is called on property changes.
   * @returns {{proxy: Proxy, revoke: Function}} An object containing the reactive proxy and a revoke function.
   */
  createReactiveProxy(e, t, n) {
    const o = {
      set(a, l, d) {
        t && typeof d == "object" && d !== null && (d = this.createReactiveProxy(d, t, n).proxy);
        const c = a[l];
        return a[l] = d, Object.is(c, d) || n.invalidateProxy?.(), !0;
      },
      deleteProperty(a, l) {
        return delete a[l], n.invalidateProxy?.(), !0;
      }
    }, { proxy: i, revoke: s } = Proxy.revocable(e, o);
    if (t)
      for (const a in e)
        typeof e[a] == "object" && e[a] !== null && (e[a] = this.createReactiveProxy(e[a], t, n).proxy);
    return { proxy: i, revoke: s };
  }
  defineComponent = async (e) => {
    customElements.get(e.name) || customElements.define(
      e.name,
      class extends HTMLElement {
        constructor() {
          super(), this.variables = {}, this.componentName = e.name, this.props = {}, this.presenterReadyPromise = new Promise((t) => {
            this.onPresenterReady = t;
          }), this.isPresenterReady = !1, this.renderCompletePromise = null, this.onRenderComplete = null, this.resetRenderCompletePromise();
        }
        resetRenderCompletePromise() {
          typeof this.onRenderComplete == "function" && (this.onRenderComplete(), this.onRenderComplete = null);
          this.renderCompletePromise = new Promise((t) => {
            this.onRenderComplete = t;
          });
        }
        resolveRenderComplete() {
          typeof this.onRenderComplete == "function" && (this.onRenderComplete(), this.onRenderComplete = null);
        }
        invalidateProxy() {
          this.invalidateFn && this.invalidateFn();
        }
        async connectedCallback() {
          this._webSkelProps && (this.props = this._webSkelProps.proxy), this.resources = await h.instance.ResourceManager.loadComponent(e), k(this.resources.html).forEach((i) => {
            i = i.slice(2), this.variables[i] = "";
          }), this.templateArray = x(this.resources.html);
          let n = this, o = null;
          for (const i of n.attributes)
            n.variables[i.nodeName] = y(i.nodeValue), i.name === "data-presenter" && (o = i.nodeValue);
          if (o) {
            const i = async (a) => {
              const l = (c) => {
                const f = c?.stack ? c.stack.split(`
`)[1] || "" : "";
                n.innerHTML = `Error rendering component: ${n.componentName}
: ` + c + f, console.error(c), n.resolveRenderComplete();
              }, d = async () => {
                try {
                  n.resetRenderCompletePromise();
                  await n.webSkelPresenter.beforeRender();
                  for (let c in n.variables)
                    typeof n.webSkelPresenter[c] < "u" && (n.variables[c] = n.webSkelPresenter[c]);
                  n.refresh(), await h.instance.ResourceManager.waitForDescendantRenders(n), await n.webSkelPresenter.afterRender?.(), n.resolveRenderComplete();
                } catch (c) {
                  l(c);
                }
              };
              const c = h.instance.showLoading();
              try {
                if (a)
                  await a();
                await d();
              } catch (f) {
                l(f);
              } finally {
                h.instance.hideLoading(c);
              }
            }, s = new Proxy(i, {
              apply: async function(a, l, d) {
                return n.isPresenterReady || await n.presenterReadyPromise, Reflect.apply(a, l, d);
              }
            });
            n.invalidateFn = s, n.webSkelPresenter = h.instance.ResourceManager.initialisePresenter(o, n, s, this.props);
          } else
            n.refresh(), n.resolveRenderComplete();
        }
        async disconnectedCallback() {
          this._webSkelProps?.revoke(), this.webSkelPresenter && this.webSkelPresenter.afterUnload && await this.webSkelPresenter.afterUnload(), this.resources && this.resources.css && await h.instance.ResourceManager.unloadStyleSheets(this.componentName);
        }
        refresh() {
          let t = "";
          for (let n of this.templateArray)
            n.startsWith("$$") ? t += this.variables[n.slice(2)] : t += n;
          this.innerHTML = t;
        }
      }
    );
  };
}
export {
  L as ResourceManager,
  h as WebSkel,
  H as closeModal,
  x as createTemplateArray,
  T as customTrim,
  h as default,
  _ as extractFormInformation,
  k as findDoubleDollarWords,
  Q as getBrowser,
  g as getClosestParentElement,
  b as getClosestParentWithPresenter,
  Z as getHashParams,
  O as getMainAppContainer,
  X as getURLParams,
  P as imageUpload,
  j as invalidateParentElement,
  $ as moveCursorToEnd,
  M as normalizeSpaces,
  A as notBasePage,
  E as refreshElement,
  C as removeActionBox,
  w as reverseQuerySelector,
  y as sanitize,
  I as showActionBox,
  S as showModal,
  R as unsanitize
};
