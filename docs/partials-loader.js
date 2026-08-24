async function includePartials() {
    const includeNodes = Array.from(document.querySelectorAll('[data-include]'));
    await Promise.all(includeNodes.map(async (node) => {
        const target = node.getAttribute('data-include');
        if (!target) {
            return;
        }
        const response = await fetch(target);
        if (!response.ok) {
            throw new Error(`Failed to load partial: ${target}`);
        }
        node.outerHTML = await response.text();
    }));
}

function markActivePage() {
    const currentFile = window.location.pathname.split('/').pop();
    const currentPage = document.body.dataset.page || (currentFile === 'specsLoader.html' ? 'specs' : '');
    if (!currentPage) {
        return;
    }
    const active = document.querySelector(`.site-nav a[data-page="${currentPage}"]`);
    if (active) {
        active.setAttribute('aria-current', 'page');
    }
}

function initializeNavigation() {
    const menus = Array.from(document.querySelectorAll('.nav-menu'));

    function closeMenu(menu, restoreFocus = false) {
        const trigger = menu.querySelector('.nav-menu__trigger');
        menu.classList.remove('is-open');
        trigger?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) {
            trigger?.focus();
        }
    }

    for (const menu of menus) {
        const trigger = menu.querySelector('.nav-menu__trigger');
        trigger?.addEventListener('click', () => {
            const opening = !menu.classList.contains('is-open');
            for (const candidate of menus) {
                closeMenu(candidate);
            }
            if (opening) {
                menu.classList.add('is-open');
                trigger.setAttribute('aria-expanded', 'true');
            }
        });
    }

    document.addEventListener('click', (event) => {
        for (const menu of menus) {
            if (!menu.contains(event.target)) {
                closeMenu(menu);
            }
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') {
            return;
        }
        const openMenu = menus.find((menu) => menu.classList.contains('is-open'));
        if (openMenu) {
            closeMenu(openMenu, true);
        }
    });
}

function initializeThemeToggle() {
    const trigger = document.getElementById('themeToggle');
    if (!trigger) {
        return;
    }
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.body.setAttribute('data-theme', savedTheme);
    trigger.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
    trigger.addEventListener('click', () => {
        const nextTheme = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.body.setAttribute('data-theme', nextTheme);
        localStorage.setItem('theme', nextTheme);
        trigger.textContent = nextTheme === 'dark' ? '☀️' : '🌙';
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await includePartials();
        markActivePage();
        initializeNavigation();
        initializeThemeToggle();
    } catch (error) {
        console.error(error);
    }
});
