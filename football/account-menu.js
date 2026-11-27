// The football page uses the site's account API without loading its page router.
export function initFootballAccount({request, onSession, onLogout, onError}) {
    const root = document.querySelector('[data-football-account]');
    let state = null, refreshVersion = 0;
    const dialog = document.createElement('dialog');
    dialog.className = 'football-account-dialog';
    dialog.setAttribute('aria-labelledby', 'footballLoginTitle');
    dialog.innerHTML = `<h2 id="footballLoginTitle">Sign in to Bonk Critic</h2>
        <p>Use your Bonk account to sign in and load your saved football controls.</p>
        <form id="footballLoginForm">
            <div class="field"><label for="footballUsername">Bonk username</label><input id="footballUsername" name="username" autocomplete="username" maxlength="100" required></div>
            <div class="field"><label for="footballPassword">Bonk password</label><input id="footballPassword" name="password" type="password" autocomplete="current-password" maxlength="1024" required></div>
            <p>Your password is sent securely to Bonk through Bonk Critic and is not saved by this site.</p>
            <p id="footballLoginError" role="status" aria-live="polite"></p>
            <div class="football-account-actions"><button type="button" class="button-secondary" data-close-login>Cancel</button><button type="submit" class="button-primary">Sign in</button></div>
        </form>`;
    document.getElementById('footballApp').append(dialog);
    const form = dialog.querySelector('form'), password = form.elements.password;
    dialog.querySelector('[data-close-login]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => {password.value = '';});
    dialog.addEventListener('click', event => {if (event.target === dialog) dialog.close();});

    function saveSession(token) {
        try {
            sessionStorage.removeItem('admin_session_token');
            if (token) sessionStorage.setItem('bonk_account_session', token);
            else sessionStorage.removeItem('bonk_account_session');
        } catch {}
    }

    function draw() {
        root.replaceChildren();
        const user = state?.user;
        if (!user) {
            const button = document.createElement('button'); button.type = 'button';
            button.className = 'account-open-login'; button.textContent = 'Account';
            button.onclick = () => {dialog.querySelector('[role="status"]').textContent = ''; dialog.showModal();};
            root.append(button); return;
        }
        const menu = document.createElement('details'), summary = document.createElement('summary');
        menu.className = 'user-account-menu';
        const avatar = document.createElement('span'), initial = document.createElement('span'), username = document.createElement('span');
        avatar.className = 'account-avatar'; avatar.setAttribute('aria-hidden', 'true');
        initial.className = 'account-avatar-initial'; initial.textContent = Array.from(user.username || '?')[0].toUpperCase(); avatar.append(initial);
        if (typeof user.avatar_code === 'string' && user.avatar_code.length <= 20000) {
            const img = document.createElement('img'); img.alt = ''; img.draggable = false; img.decoding = 'async';
            img.setAttribute('data-bonk-avatar', ''); img.setAttribute('data-bonk-skin', user.avatar_code);
            img.addEventListener('load', () => avatar.classList.add('has-skin'));
            img.addEventListener('error', () => {avatar.classList.remove('has-skin'); img.remove();}); avatar.append(img);
        }
        username.className = 'account-username'; username.textContent = user.username;
        const arrow = document.createElement('span'); arrow.textContent = '▾'; arrow.setAttribute('aria-hidden', 'true');
        summary.append(avatar, username, arrow); menu.append(summary);
        const options = document.createElement('div'); options.className = 'user-account-options';
        const profile = document.createElement('a'); profile.href = '../#/profile'; profile.textContent = 'Profile'; options.append(profile);
        if (state.admin_account) {
            const admin = document.createElement('a'); admin.href = '../#/admin'; admin.textContent = 'Admin tools'; options.append(admin);
        }
        const logout = document.createElement('button'); logout.type = 'button'; logout.className = 'account-logout'; logout.textContent = 'Log out';
        logout.onclick = async () => {
            logout.disabled = true;
            try {
                await request('/api/bonk/logout', {}); saveSession(null); state = null;
                await onLogout?.(); draw(); await onSession?.(null, 'logout');
            } catch (error) {onError?.(error.message); logout.disabled = false;}
        };
        options.append(logout); menu.append(options); root.append(menu);
        options.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {menu.open = false;}));
    }

    async function refresh(reason = 'refresh') {
        const ownVersion = ++refreshVersion;
        try {
            const next = await request('/api/session');
            if (ownVersion !== refreshVersion) return state;
            state = next; draw(); await onSession?.(state, reason); return state;
        } catch (error) {
            if (reason === 'login') throw error;
            return state;
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('[type="submit"]'), status = form.querySelector('[role="status"]');
        if (button.disabled) return;
        button.disabled = true; status.textContent = 'Signing in…';
        try {
            const result = await request('/api/bonk/login', {username: form.elements.username.value.trim(), password: password.value});
            password.value = ''; saveSession(result.account_session_token);
            await refresh('login'); if (dialog.open) dialog.close();
        } catch (error) {status.textContent = error.message;}
        finally {password.value = ''; button.disabled = false;}
    });
    document.addEventListener('click', event => {const menu = root.querySelector('details'); if (menu && !root.contains(event.target)) menu.open = false;});
    document.addEventListener('keydown', event => {const menu = root.querySelector('details'); if (event.key === 'Escape' && menu?.open) {menu.open = false; menu.querySelector('summary').focus();}});
    window.addEventListener('focus', () => {void refresh();});
    draw();
    return {refresh};
}
