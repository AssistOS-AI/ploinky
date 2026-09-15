class k {
  constructor() {
    this.loadedStyleSheets = /* @__PURE__ */ new Map(), this.components = {};
  }
  async loadStyleSheets(e, t) {
    const n = [];
    return n.push(...e.map((s) => this.loadStyleSheet({
      cssText: s,
      identifier: t
    }))), (await Promise.all(n)).join("");
  }
  async loadStyleSheet({ url: e = null, cssText: t = null, identifier: n = null }) {
    if (!e && !t)
      return;
    const s = n || e;
    let i = this.loadedStyleSheets.get(s) || 0;
    if (i === 0)
      return new Promise((o, a) => {
        try {
          const l = document.createElement("style");
          l.textContent = t, n && (l.className = n), document.head.appendChild(l), this.loadedStyleSheets.set(s, i + 1), o(l.outerHTML);
        } catch (l) {
          a(new Error(`Failed to inject the CSS text: ${l.message}`));
        }
      });
    this.loadedStyleSheets.set(s, i + 1);
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
      function t(n, s) {
        const { rootDir: i, webComponentsRootDir: o } = h.instance.configs;
        let a = i || o || "";
        return n.directory && (a = `${a}/${n.directory}`), a || (a = o ? `./${o}${n.directory ? `/${n.directory}` : ""}` : `${n.directory ? `/${n.directory}` : ""}`), `${a}/${n.type}/${n.name}/${n.name}.${s}`;
      }
      try {
        let n, s;
        n = t(e, "html"), s = t(e, "css");
        const i = e.loadedTemplate || await (await fetch(n)).text();
        this.components[e.name].html = i;
        const o = e.loadedCSSs || [await (await fetch(s)).text()];
        if (this.components[e.name].css = o, await this.loadStyleSheets(o, e.name), e.presenterClassName)
          if (e.presenterModule)
            this.registerPresenter(e.name, e.presenterModule[e.presenterClassName]);
          else {
            const l = await import(t(e, "js"));
            this.registerPresenter(e.name, l[e.presenterClassName]);
          }
        return this.components[e.name].isPromiseFulfilled = !0, { html: i, css: o };
      } catch (n) {
        throw n;
      }
    })();
  }
  registerPresenter(e, t) {
    this.components[e].presenter = t;
  }
  initialisePresenter(e, t, n, s = {}) {
    let i;
    try {
      i = new this.components[t.componentName].presenter(t, n, s), t.isPresenterReady = !0, t.onPresenterReady();
    } catch (o) {
      showApplicationError("Error creating a presenter instance", `Encountered an error during the initialization of ${e} for component: ${t.componentName}`, o + ":" + o.stack.split(`
`)[1]);
    }
    return i;
  }
  async waitForDescendantRenders(e) {
    await Promise.resolve();
    const n = [...e.querySelectorAll("[data-presenter]")].filter((s) => s !== e).map((s) => s.renderCompletePromise).filter((s) => s && typeof s.then == "function");
    n.length && await Promise.allSettled(n);
  }
}
function x(r) {
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
  const s = /* @__PURE__ */ new Set();
  if (!(r instanceof Element))
    throw new TypeError("The first argument must be a DOM Element.");
  if (typeof e != "string" || e.trim() === "")
    throw new TypeError("The second argument must be a non-empty string.");
  if (r.matches(e) && !n)
    return r;
  s.add(r);
  let i = r;
  for (; i; ) {
    const o = i.parentElement;
    if (o) {
      let a = o.firstElementChild;
      for (; a; ) {
        if (!s.has(a)) {
          if (s.add(a), a !== i && a.matches(e))
            return a;
          if (a.children.length > 0) {
            const l = [a.firstElementChild];
            for (; l.length > 0; ) {
              const c = l.shift();
              if (!s.has(c)) {
                if (s.add(c), c.matches(e))
                  return c;
                let d = c.nextElementSibling;
                for (; d; )
                  l.push(d), d = d.nextElementSibling;
                c.firstElementChild && l.push(c.firstElementChild);
              }
            }
          }
        }
        a = a.nextElementSibling;
      }
    }
    if (i = o, i && !s.has(i)) {
      if (s.add(i), i.matches(e))
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
function $(r) {
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
function I(r) {
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
const _ = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  customTrim: T,
  getClosestParentElement: g,
  getClosestParentWithPresenter: b,
  getMainAppContainer: O,
  invalidateParentElement: I,
  moveCursorToEnd: x,
  normalizeSpaces: M,
  notBasePage: A,
  refreshElement: E,
  reverseQuerySelector: w,
  sanitize: y,
  unsanitize: $
}, Symbol.toStringTag, { value: "Module" }));
async function U(r, e) {
  const t = g(r, "form"), n = {
    data: {},
    elements: {},
    isValid: !1
  };
  typeof t.checkValidity == "function" && (n.isValid = t.checkValidity());
  const s = [...t.querySelectorAll("[name]:not([type=hidden])")];
  for (const i of s) {
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
    let o = !0;
    if (i.setCustomValidity(""), typeof i.checkValidity == "function" ? o = i.checkValidity() : typeof i.getInputElement == "function" && (o = (await i.getInputElement()).checkValidity()), o === !0 && e) {
      let l = i.getAttribute("data-condition");
      l && (o = e[l].fn(i, n), o ? i.setCustomValidity("") : (i.setCustomValidity(e[l].errorMessage), n.isValid = !1));
    }
    n.elements[i.name] = {
      isValid: o,
      element: i
    };
    let a = document.querySelector(`[data-id = '${i.getAttribute("id")}' ]`);
    a && (o ? a.classList.remove("input-invalid") : a.classList.add("input-invalid"));
  }
  t.checkValidity() || t.reportValidity();
  for (let i of Object.keys(n.data))
    n.elements[i] && n.elements[i].element && n.elements[i].element.hasAttribute("data-no-sanitize") || (n.data[i] = y(n.data[i]));
  return n;
}
async function P(r) {
  let e = "", t = new FileReader();
  return await new Promise((n, s) => {
    t.onload = function() {
      e = t.result, n(e);
    }, r ? t.readAsDataURL(r) : s("No file given as input at imageUpload");
  });
}
async function j(r) {
  let e = "", t = new FileReader();
  return await new Promise((n, s) => {
    t.onload = function() {
      e = t.result, n(e);
    }, r ? t.readAsText(r) : s("No file given as input");
  });
}
const F = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  extractFormInformation: U,
  imageUpload: P,
  uploadFileAsText: j
}, Symbol.toStringTag, { value: "Module" }));
async function C(r, e, t) {
  typeof e == "boolean" && (t = e, e = void 0);
  const n = document.querySelector("body"), s = g(n, "dialog");
  s && (s.close(), s.remove());
  const i = Object.assign(N(r, e), {
    component: r,
    cssClass: r,
    componentProps: e
  });
  return n.appendChild(i), await i.showModal(), i.addEventListener("keydown", S), t ? new Promise((o) => {
    i.addEventListener("close", (a) => {
      o(a.data);
    });
  }) : i;
}
function S(r) {
  r.key === "Escape" && r.preventDefault();
}
function N(r, e) {
  let t = document.createElement("dialog"), n = "";
  return e !== void 0 && Object.keys(e).forEach((i) => {
    n += ` data-${i}="${e[i]}"`;
  }), h.instance.configs.components.find((i) => i.name === r).presenterClassName && (n += ` data-presenter="${r}"`), n === "" ? t.innerHTML = `<${r}/>` : t.innerHTML = `<${r}${n}/>`, t.classList.add("modal", `${r}-dialog`), t;
}
function D(r, e) {
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
function v(r, e) {
  document.removeEventListener("click", r.clickHandler), r.remove(), e !== void 0 && delete e.actionBox;
}
async function V(r, e, t, n, s = {}) {
  if (r.parentNode.querySelector(t))
    return null;
  const o = document.createElement(`${t}`);
  for (const [c, d] of Object.entries(s))
    o.setAttribute(`data-${c}`, d);
  let a;
  switch (n) {
    case "prepend":
      r.parentNode.insertBefore(o, r);
      break;
    case "append":
      r.parentNode.appendChild(o);
      break;
    case "replace":
      a = r;
      const c = a.parentNode;
      c.removeChild(a), c.appendChild(o);
      break;
    case "replace-all":
      a = r.parentNode;
      const d = a;
      a = d.innerHTML, d.innerHTML = "", d.appendChild(o);
      break;
    default:
      console.error(`Invalid Insertion Mode: ${n}. No changes to the DOM have been made`);
      return;
  }
  let l = (c) => {
    if (o && !o.contains(c.target)) {
      if (n === "replace" && a) {
        const d = o.parentNode;
        d.removeChild(o), d.appendChild(a);
      } else if (n === "replace-all" && a) {
        const d = o.parentNode;
        d.innerHTML = a;
      }
      v(o);
    }
  };
  return o.clickHandler = l, document.addEventListener("click", l), o;
}
async function q(r, e, t = !1) {
  typeof e == "boolean" && (t = e, e = void 0);
  const n = document.querySelector("body"), s = g(n, "dialog");
  s && (s.close(), s.remove());
  let i = document.createElement("dialog");
  i.classList.add("modal", `${r}-dialog`);
  const o = window.WebSkel || assistOS.UI;
  if (!o)
    throw new Error("WebSkel instance not found for reactive modal");
  let a = o.configs.components.find((d) => d.name === r);
  const l = o.createElement(
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
  const c = new Proxy(i, {
    get(d, f) {
      return f === "props" ? l : Reflect.get(d, f);
    }
  });
  return n.appendChild(i), await i.showModal(), i.addEventListener("keydown", S), t ? new Promise((d) => {
    i.addEventListener("close", (f) => {
      d(f.data);
    });
  }) : c;
}
const B = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  closeModal: D,
  createReactiveModal: q,
  removeActionBox: v,
  showActionBox: V,
  showModal: C
}, Symbol.toStringTag, { value: "Module" }));
function R(r) {
  let e = /\$\$[\w\-_]+/g;
  return r.match(e) || [];
}
function L(r) {
  let e = 0;
  const t = 0, n = 1;
  function s(l) {
    return !/^[a-zA-Z0-9_\-$]$/.test(l);
  }
  function i(l) {
    return r[l] !== "$" || r[l + 1] !== "$" ? t : n;
  }
  let o = [], a = 0;
  for (; a < r.length; ) {
    for (; !i(a) && a < r.length; )
      a++;
    for (o.push(r.slice(e, a)), e = a; !s(r[a]) && a < r.length; )
      a++;
    o.push(r.slice(e, a)), e = a;
  }
  return o;
}
function H(r, e) {
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
  createTemplateArray: L,
  decodeBase64: z,
  encodeToBase64: H,
  findDoubleDollarWords: R
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
function Y() {
  const r = window.location.hash.split("?");
  let e = {};
  if (r[1]) {
    const t = new URLSearchParams(r[1]);
    for (const [n, s] of t)
      e[n] = s;
    return e;
  }
  return e;
}
const Z = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  getBrowser: Q,
  getHashParams: Y,
  getURLParams: X
}, Symbol.toStringTag, { value: "Module" }));
function G(r = globalThis.crypto) {
  if (typeof r?.randomUUID == "function")
    return r.randomUUID();
  if (typeof r?.getRandomValues != "function") {
    const n = new Error("Secure UUID generation requires crypto.randomUUID() or crypto.getRandomValues().");
    throw n.code = "WEB_CRYPTO_UNAVAILABLE", n;
  }
  const e = new Uint8Array(16);
  r.getRandomValues(e), e[6] = e[6] & 15 | 64, e[8] = e[8] & 63 | 128;
  const t = Array.from(e, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`;
}
class h {
  constructor() {
    this._appContent = {}, this.appServices = {}, this._documentElement = document, this.actionRegistry = {}, this.registerListeners(), this.ResourceManager = new k(), this.defaultLoader = document.createElement("dialog"), this.loaderCount = 0, this.activeLoaderId = null, this.defaultLoader.classList.add("spinner"), this.defaultLoader.classList.add("spinner-default-style"), window.showApplicationError = async (e, t, n) => await C("show-error-modal", {
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
      _,
      F,
      B,
      K,
      Z
    ];
    for (const s of n)
      for (const [i, o] of Object.entries(s))
        t[i] = o;
    return await t.loadConfigs(e), h.instance = t, h.instance;
  }
  async loadConfigs(e) {
    try {
      const n = await (await fetch(e)).json();
      this.configs = n;
      for (const s of n.components)
        await this.defineComponent(s);
    } catch (t) {
      console.error(t), await window.showApplicationError("Error loading configs", "Error loading configs", `Encountered ${t} while trying loading webSkel configs`);
    }
  }
  showLoading() {
    const e = this.activeLoaderId || G();
    if (this.loaderCount === 0) {
      let t = this.defaultLoader.cloneNode(!0);
      return t.setAttribute("data-id", e), document.body.appendChild(t), t.showModal(), this.activeLoaderId = e, this.loaderCount = 1, e;
    }
    return this.loaderCount++, this.activeLoaderId;
  }
  clearLoading() {
    document.querySelectorAll(".spinner").forEach((e) => {
      e.close(), e.remove();
    }), this.loaderCount = 0, this.activeLoaderId = null;
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
      if (n)
        n.close(), n.remove();
      else {
        this.clearLoading();
        return;
      }
    } else
      this.clearLoading();
    this.loaderCount = 0, this.activeLoaderId = null;
  }
  setLoading(e) {
    this.defaultLoader.innerHTML = e, this.defaultLoader.classList.remove("spinner-default-style");
  }
  resetLoading() {
    this.defaultLoader = document.createElement("dialog"), this.defaultLoader.classList.add("spinner"), this.defaultLoader.classList.add("spinner-default-style");
  }
  async changeToDynamicPage(e, t, n, s) {
    try {
      this.validateTagName(e);
    } catch (a) {
      await window.showApplicationError(`Failed to navigate to ${e} with Url ${t}`, a.message, a.stack.toString()), console.error(a);
      return;
    }
    const i = this.showLoading();
    let o = "";
    n && (o = Object.entries(n).map(([a, l]) => `data-${a}="${l}"`).join(" "));
    try {
      const a = `<${e} data-presenter="${e}" ${o}></${e}>`;
      if (!s) {
        const c = ["#", t].join("");
        window.history.pushState({ pageHtmlTagName: e, relativeUrlContent: a }, c.toString(), c);
      }
      await this.updateAppContent(a);
      const l = this._appContent.querySelector(e);
      l && l.renderCompletePromise && await l.renderCompletePromise;
    } catch (a) {
      console.error("Failed to change page", a), await window.showApplicationError("Failed to change page", a.message || "Failed to change page.", a.stack || String(a));
    } finally {
      this.hideLoading(i);
    }
  }
  validateTagName(e) {
    if (!/^(?![0-9])[a-z0-9]+(?:-*[a-z0-9]+)*-*?$/.test(e))
      throw new Error(`Invalid tag name: ${e}`);
    if (!this.configs.components.find((s) => s.name === e))
      throw new Error(`Element not found in configs: ${e}`);
  }
  async changeToStaticPage(e, t) {
    const n = this.showLoading();
    try {
      const s = await this.fetchTextResult(e, t);
      await this.updateAppContent(s);
      const i = this._appContent.querySelectorAll("[data-presenter]"), o = Array.from(i).map((a) => a.renderCompletePromise).filter(Boolean);
      o.length && await Promise.all(o);
    } catch (s) {
      console.error("Failed to change page", s), await window.showApplicationError("Failed to change page", s.message || "Failed to change page.", s.stack || String(s));
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
      for (let s of n) {
        let i = s.split('"')[1], o = new URL(i).host;
        if (window.location.host !== o)
          throw new Error(`External resource detected: ${i}`);
      }
  }
  registerListeners() {
    this._documentElement.addEventListener("click", this.interceptAppContentLinks.bind(this)), window.onpopstate = async (e) => {
      if (typeof this._appContent?.querySelector != "function")
        return;
      const t = window.location.hash;
      if (t) {
        const n = t.substring(1), s = n.split("/")[0].split("?")[0];
        if (this.configs.components.find((o) => o.name === s)) {
          const o = this._appContent.querySelector(s);
          if (o && o.webSkelPresenter)
            return;
          await this.changeToDynamicPage(s, n, null, !0);
          return;
        }
      }
      if (e.state && e.state.relativeUrlContent) {
        await this.updateAppContent(e.state.relativeUrlContent);
        const n = this._appContent.querySelectorAll("[data-presenter]"), s = Array.from(n).map((i) => i.renderCompletePromise).filter(Boolean);
        s.length && await Promise.all(s);
      }
    }, this._documentElement.addEventListener("click", async (e) => {
      let t = e.target, n = !1;
      for (; t && t !== this._documentElement && !n; ) {
        if (t.hasAttribute("data-local-action")) {
          e.preventDefault(), e.stopPropagation(), n = !0;
          let s = t, i = !1;
          const o = t.getAttribute("data-local-action"), [a, ...l] = o.split(" ");
          for (; i === !1; ) {
            let c = !1, d;
            for (; c === !1; ) {
              if (s.webSkelPresenter) {
                c = !0, d = s.webSkelPresenter;
                break;
              }
              if (s = s.parentElement, s === document) {
                await window.showApplicationError("Error executing action", "Action not found in any Presenter", "Action not found in any Presenter");
                return;
              }
            }
            if (d[a] !== void 0)
              try {
                s.webSkelPresenter[a](t, ...l), i = !0;
              } catch (f) {
                console.error(f), await window.showApplicationError("Error executing action", "There is no action for the button to execute", `Encountered ${f}`);
                return;
              }
            else
              c = !1, s = s.parentElement;
          }
        } else if (t.hasAttribute("data-action")) {
          e.preventDefault(), e.stopPropagation(), n = !0;
          const s = t.getAttribute("data-action"), [i, ...o] = s.split(" ");
          i ? this.callAction(i, t, ...o) : console.error(`${t} : data action attribute value should not be empty!`);
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
    let s = t && t[0] instanceof HTMLElement ? t[0] : null;
    n.call(s, ...t);
  }
  async fetchTextResult(e, t) {
    const n = new URL(`${window.location.protocol}//${window.location.host}`);
    e.startsWith("#") && (e = e.slice(1)), console.log("Fetching Data from URL: ", n + e);
    const s = await fetch(n + e);
    if (!s.ok)
      throw new Error("Failed to execute request");
    const i = await s.text();
    if (!t) {
      const o = n + "#" + e;
      window.history.pushState({ relativeUrlPath: e, relativeUrlContent: i }, o.toString(), o);
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
  createElement(e, t = null, n = {}, s = {}, i = !1) {
    const o = document.createElement(e), { proxy: a, revoke: l } = this.createReactiveProxy(n, i, o);
    o.setAttribute("data-presenter", e);
    const c = {
      get(f, u, p) {
        if (u === "element")
          return new WeakRef(o);
        if (u in a)
          return Reflect.get(a, u, p);
        if (u in o) {
          const m = o[u];
          return typeof m == "function" ? m.bind(o) : m;
        }
        return Reflect.get(f, u, p);
      },
      set(f, u, p, m) {
        return u === "element" ? !1 : u in a ? Reflect.set(a, u, p, m) : u in o ? (o[u] = p, !0) : Reflect.set(a, u, p, m);
      },
      has(f, u) {
        return u === "element" || u in a || u in o;
      },
      ownKeys(f) {
        const u = Reflect.ownKeys(a), p = Reflect.ownKeys(o);
        return [.../* @__PURE__ */ new Set([...u, ...p, "element"])];
      },
      getOwnPropertyDescriptor(f, u) {
        return u === "element" ? {
          value: new WeakRef(o),
          writable: !1,
          enumerable: !0,
          configurable: !1
        } : u in a ? Reflect.getOwnPropertyDescriptor(a, u) : u in o ? Reflect.getOwnPropertyDescriptor(o, u) : Reflect.getOwnPropertyDescriptor(f, u);
      }
    }, d = new Proxy({}, c);
    return o._webSkelProps = {
      raw: n,
      proxy: a,
      revoke: l,
      observeProps: i
    }, Object.entries(s).forEach(([f, u]) => {
      o.setAttribute(f, u);
    }), t instanceof HTMLElement ? t?.appendChild(o) : typeof t == "string" && document.querySelector(t)?.appendChild(o), d;
  }
  /**
   * Creates a reactive proxy for an object that triggers an element invalidation on property changes.
   * @param {Object} target - The target object to wrap in a reactive proxy.
   * @param {boolean} observe - If true, nested objects are also wrapped in reactive proxies.
   * @param {HTMLElement} element - The element whose invalidate method is called on property changes.
   * @returns {{proxy: Proxy, revoke: Function}} An object containing the reactive proxy and a revoke function.
   */
  createReactiveProxy(e, t, n) {
    const s = {
      set(a, l, c) {
        t && typeof c == "object" && c !== null && (c = this.createReactiveProxy(c, t, n).proxy);
        const d = a[l];
        return a[l] = c, Object.is(d, c) || n.invalidateProxy?.(), !0;
      },
      deleteProperty(a, l) {
        return delete a[l], n.invalidateProxy?.(), !0;
      }
    }, { proxy: i, revoke: o } = Proxy.revocable(e, s);
    if (t)
      for (const a in e)
        typeof e[a] == "object" && e[a] !== null && (e[a] = this.createReactiveProxy(e[a], t, n).proxy);
    return { proxy: i, revoke: o };
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
          typeof this.onRenderComplete == "function" && (this.onRenderComplete(), this.onRenderComplete = null), this.renderCompletePromise = new Promise((t) => {
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
          this._webSkelProps && (this.props = this._webSkelProps.proxy), this.resources = await h.instance.ResourceManager.loadComponent(e), R(this.resources.html).forEach((i) => {
            i = i.slice(2), this.variables[i] = "";
          }), this.templateArray = L(this.resources.html);
          let n = this, s = null;
          for (const i of n.attributes)
            n.variables[i.nodeName] = y(i.nodeValue), i.name === "data-presenter" && (s = i.nodeValue);
          if (s) {
            const i = async (a) => {
              const l = (f) => {
                const u = f?.stack && f.stack.split(`
`)[1] || "";
                n.innerHTML = `Error rendering component: ${n.componentName}
: ` + f + u, console.error(f), n.resolveRenderComplete();
              }, c = async () => {
                try {
                  n.resetRenderCompletePromise(), await n.webSkelPresenter.beforeRender();
                  for (let f in n.variables)
                    typeof n.webSkelPresenter[f] < "u" && (n.variables[f] = n.webSkelPresenter[f]);
                  n.refresh(), await h.instance.ResourceManager.waitForDescendantRenders(n), await n.webSkelPresenter.afterRender?.(), n.resolveRenderComplete();
                } catch (f) {
                  l(f);
                }
              }, d = h.instance.showLoading();
              try {
                a && await a(), await c();
              } catch (f) {
                l(f);
              } finally {
                h.instance.hideLoading(d);
              }
            }, o = new Proxy(i, {
              apply: async function(a, l, c) {
                return n.isPresenterReady || await n.presenterReadyPromise, Reflect.apply(a, l, c);
              }
            });
            n.invalidateFn = o, n.webSkelPresenter = h.instance.ResourceManager.initialisePresenter(s, n, o, this.props);
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
  k as ResourceManager,
  h as WebSkel,
  D as closeModal,
  G as createSecureUuid,
  L as createTemplateArray,
  T as customTrim,
  h as default,
  U as extractFormInformation,
  R as findDoubleDollarWords,
  Q as getBrowser,
  g as getClosestParentElement,
  b as getClosestParentWithPresenter,
  Y as getHashParams,
  O as getMainAppContainer,
  X as getURLParams,
  P as imageUpload,
  I as invalidateParentElement,
  x as moveCursorToEnd,
  M as normalizeSpaces,
  A as notBasePage,
  E as refreshElement,
  v as removeActionBox,
  w as reverseQuerySelector,
  y as sanitize,
  V as showActionBox,
  C as showModal,
  $ as unsanitize
};
