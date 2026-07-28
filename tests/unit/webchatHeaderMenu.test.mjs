import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeaderMenu, createResponsiveHeaderActions } from '../../cli/server/webchat/headerMenu.js';

function createClassList() {
    const values = new Set();
    return {
        toggle(name, force) {
            if (force) values.add(name);
            else values.delete(name);
        },
        contains(name) {
            return values.has(name);
        },
    };
}

function createEventTarget() {
    const listeners = new Map();
    return {
        listeners,
        classList: createClassList(),
        attributes: new Map(),
        focused: false,
        addEventListener(name, listener) {
            listeners.set(name, listener);
        },
        removeEventListener(name, listener) {
            if (listeners.get(name) === listener) listeners.delete(name);
        },
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        contains(target) {
            return target === this;
        },
        focus() {
            this.focused = true;
        },
    };
}

test('header overflow menu toggles, closes after actions, and supports outside click and Escape', () => {
    const button = createEventTarget();
    const panel = createEventTarget();
    const documentRef = createEventTarget();
    const menu = createHeaderMenu({ button, panel, documentRef });

    button.listeners.get('click')({ stopPropagation() {} });
    assert.equal(menu.isOpen(), true);
    assert.equal(button.attributes.get('aria-expanded'), 'true');

    panel.listeners.get('click')({ target: { closest: () => ({}) } });
    assert.equal(menu.isOpen(), false);

    menu.open();
    documentRef.listeners.get('pointerdown')({ target: {} });
    assert.equal(menu.isOpen(), false);

    menu.open();
    documentRef.listeners.get('keydown')({ key: 'Escape' });
    assert.equal(menu.isOpen(), false);
    assert.equal(button.focused, true);

    menu.destroy();
    assert.equal(button.listeners.size, 0);
    assert.equal(panel.listeners.size, 0);
});

function createContainer(initialChildren = []) {
    const container = {
        children: [],
        append(action) {
            action.parentNode?.remove(action);
            this.children.push(action);
            this.sync();
        },
        insertBefore(action, nextSibling) {
            action.parentNode?.remove(action);
            const index = nextSibling ? this.children.indexOf(nextSibling) : this.children.length;
            this.children.splice(index < 0 ? this.children.length : index, 0, action);
            this.sync();
        },
        remove(action) {
            const index = this.children.indexOf(action);
            if (index >= 0) this.children.splice(index, 1);
            this.sync();
        },
        sync() {
            this.children.forEach((child, index) => {
                child.parentNode = this;
                child.nextSibling = this.children[index + 1] || null;
            });
        },
    };
    initialChildren.forEach((child) => container.append(child));
    return container;
}

test('responsive header actions stay on desktop and move into the menu only at the mobile breakpoint', () => {
    const tasks = {};
    const sessions = {};
    const settings = {};
    const logout = {};
    const desktopContainer = createContainer([tasks, sessions, settings, logout]);
    const mobileContainer = createContainer();
    const mobileSection = { hidden: false };
    const listeners = new Map();
    const mediaQuery = {
        matches: false,
        addEventListener(name, listener) {
            listeners.set(name, listener);
        },
        removeEventListener(name, listener) {
            if (listeners.get(name) === listener) listeners.delete(name);
        },
    };
    const controller = createResponsiveHeaderActions({
        actions: [tasks, sessions, logout],
        desktopContainer,
        mobileContainer,
        mobileSection,
        windowRef: { matchMedia: (query) => {
            assert.equal(query, '(max-width: 640px)');
            return mediaQuery;
        } },
    });

    assert.deepEqual(desktopContainer.children, [tasks, sessions, settings, logout]);
    assert.equal(mobileSection.hidden, true);

    mediaQuery.matches = true;
    listeners.get('change')();
    assert.deepEqual(desktopContainer.children, [settings]);
    assert.deepEqual(mobileContainer.children, [tasks, sessions, logout]);
    assert.equal(mobileSection.hidden, false);

    mediaQuery.matches = false;
    listeners.get('change')();
    assert.deepEqual(desktopContainer.children, [tasks, sessions, settings, logout]);
    assert.equal(mobileSection.hidden, true);

    controller.destroy();
    assert.equal(listeners.size, 0);
});
