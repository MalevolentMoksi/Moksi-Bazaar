// Night Bazaar client script. Everything works without it (plain forms and
// links); this layer adds instant toggles, in-place saves, and toasts.
(() => {
    'use strict';

    const csrf = document.querySelector('meta[name="csrf"]')?.content ?? '';
    const guildId = document.querySelector('meta[name="guild"]')?.content ?? '';

    function toast(message, isError = false) {
        const host = document.getElementById('toast');
        if (!host) return;
        const item = document.createElement('div');
        item.className = 'toast-item' + (isError ? ' error' : '');
        item.textContent = message;
        host.appendChild(item);
        setTimeout(() => item.remove(), isError ? 6500 : 3500);
    }

    async function api(path, body) {
        const response = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bazaar-CSRF': csrf },
            body: JSON.stringify(body ?? {}),
        });
        let data = null;
        try { data = await response.json(); } catch { /* non-JSON error page */ }
        if (!response.ok) {
            throw new Error(data?.error ?? `Request failed (${response.status})`);
        }
        return data ?? {};
    }

    // Guild picker submits itself; CSP forbids inline handlers, rightly.
    document.querySelector('.guild-pick select')
        ?.addEventListener('change', e => e.target.form.submit());

    // ── Toggles: <input type="checkbox" data-toggle="column_name"> ──────
    // Flips optimistically, saves, and flips back with an explanation if the
    // server refuses. The switch never lies for longer than one round-trip.
    document.addEventListener('change', async (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.dataset.toggle) return;
        const column = input.dataset.toggle;
        const value = input.checked;
        input.disabled = true;
        try {
            const result = await api(`/api/guild/${guildId}/settings`, { patch: { [column]: value } });
            toast(result.summary ?? 'Saved.');
        } catch (error) {
            input.checked = !value;
            toast(error.message, true);
        } finally {
            input.disabled = false;
        }
    });

    // ── Forms: <form data-api="thresholds"> posts its fields as JSON ────
    // On refusal the message lands inside the form, next to what caused it.
    document.addEventListener('submit', async (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement) || !form.dataset.api) return;
        event.preventDefault();

        // Repeated names (checkbox groups) become arrays instead of last-wins.
        const fields = {};
        for (const [key, value] of new FormData(form).entries()) {
            if (key in fields) {
                if (!Array.isArray(fields[key])) fields[key] = [fields[key]];
                fields[key].push(value);
            } else {
                fields[key] = value;
            }
        }

        let errorBox = form.querySelector('.form-error');
        const button = form.querySelector('button[type="submit"]');
        if (button) button.disabled = true;
        try {
            const result = await api(`/api/guild/${guildId}/${form.dataset.api}`, { fields });
            errorBox?.remove();
            toast(result.summary ?? 'Saved.');
            if (form.dataset.reload != null) location.reload();
        } catch (error) {
            if (!errorBox) {
                errorBox = document.createElement('div');
                errorBox.className = 'form-error';
                form.prepend(errorBox);
            }
            errorBox.textContent = error.message;
        } finally {
            if (button) button.disabled = false;
        }
    });

    // ── Buttons: <button data-action="/api/..."> for one-shot tools ─────
    document.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
        button.disabled = true;
        const label = button.textContent;
        if (button.dataset.busy) button.textContent = button.dataset.busy;
        try {
            const result = await api(button.dataset.action, {});
            toast(result.summary ?? 'Done.');
            if (button.dataset.reload != null) location.reload();
        } catch (error) {
            toast(error.message, true);
        } finally {
            button.disabled = false;
            button.textContent = label;
        }
    });

    window.bazaar = { api, toast, guildId };
})();
