export const FOOTBALL_HUB_ID = 'footballdivision';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function json(data, status, request, env) {
    return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json', 'Cache-Control':'no-store', 'Vary':'Origin', 'Access-Control-Allow-Origin':env.ALLOWED_ORIGIN || request.headers.get('Origin') || '', 'Access-Control-Allow-Credentials':'true'}});
}
// The trusted adapter supplies identity and session references, never browser JSON.
export async function footballApi(request, env, identity = null) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/football/')) return null;
    if (!env.FOOTBALL_ROOMS) return json({error:'Online football is temporarily unavailable.'}, 503, request, env);
    const lobby = url.pathname === '/api/football/lobby';
    const legacy = url.pathname.match(/^\/api\/football\/rooms(?:\/([A-Za-z0-9_-]{1,80})(?:\/(join|socket))?)?$/);
    if (!lobby && !legacy) return json({error:'Route not found.'}, 404, request, env);
    const action = legacy?.[2], isSocket = action === 'socket' && request.method === 'GET';
    const joining = request.method === 'POST' && (lobby || !action || action === 'join');
    const info = request.method === 'GET' && (lobby || !action);
    if (!joining && !info && !isSocket) return json({error:'Route not found.'}, 404, request, env);
    if ((joining || isSocket) && (!env.ALLOWED_ORIGIN || request.headers.get('Origin') !== env.ALLOWED_ORIGIN)) return json({error:'Untrusted request origin.'}, 403, request, env);
    let body = {};
    if (joining) {
        if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json({error:'Send a JSON request.'}, 400, request, env);
        const text = await request.text();
        if (text.length > 2048) return json({error:'Request too large.'}, 413, request, env);
        try {body = JSON.parse(text);} catch {return json({error:'Invalid JSON.'}, 400, request, env);}
        if (!object(body)) return json({error:'Invalid lobby request.'}, 400, request, env);
    }
    const stub = env.FOOTBALL_ROOMS.get(env.FOOTBALL_ROOMS.idFromName(FOOTBALL_HUB_ID));
    let internal;
    if (isSocket) {
        const headers = new Headers();
        for (const name of ['Origin', 'Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol']) {const value = request.headers.get(name); if (value) headers.set(name, value);}
        internal = new Request('https://football.internal/socket' + url.search, {headers});
    } else if (info) internal = new Request('https://football.internal/info');
    else {
        const trusted = identity && typeof identity.username === 'string' ? {username:identity.username, bonkId:String(identity.bonkId ?? identity.bonk_id ?? ''), userSessionHash:identity.userSessionHash || null, adminSessionHash:identity.adminSessionHash || null, adminAccountId:identity.adminAccountId || null} : null;
        internal = new Request('https://football.internal/join', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({displayName:body.displayName, resumeToken:body.resumeToken, identity:trusted})});
    }
    const response = await stub.fetch(internal);
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store'); headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || request.headers.get('Origin') || ''); headers.set('Access-Control-Allow-Credentials', 'true');
    return new Response(response.body, {status:response.status, headers});
}
