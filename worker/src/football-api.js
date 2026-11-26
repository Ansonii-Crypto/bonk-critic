// Public room requests are forwarded through this module so browser-supplied
// identity fields can never become trusted Durable Object member identities.
const ROOM_ID = /^[A-Za-z0-9_-]{16}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replaceAll('+', '-').replaceAll('/', '_');

function json(data, status, request, env) {
    return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json', 'Cache-Control':'no-store', 'Vary':'Origin', 'Access-Control-Allow-Origin':env.ALLOWED_ORIGIN || request.headers.get('Origin') || '', 'Access-Control-Allow-Credentials':'true'}});
}

export async function footballApi(request, env, identity = null) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/football/')) return null;
    if (!env.FOOTBALL_ROOMS) return json({error:'Online football is temporarily unavailable.'}, 503, request, env);
    const match = url.pathname.match(/^\/api\/football\/rooms(?:\/([A-Za-z0-9_-]+)(?:\/(join|socket))?)?$/);
    if (!match || (match[1] && !ROOM_ID.test(match[1]))) return json({error:'Room not found.'}, 404, request, env);
    const [, suppliedId, action] = match;
    const isSocket = action === 'socket' && request.method === 'GET';
    if ((request.method !== 'GET' || isSocket) && (!env.ALLOWED_ORIGIN || request.headers.get('Origin') !== env.ALLOWED_ORIGIN)) return json({error:'Untrusted request origin.'}, 403, request, env);
    const creating = !suppliedId && request.method === 'POST';
    const joining = suppliedId && action === 'join' && request.method === 'POST';
    const info = suppliedId && !action && request.method === 'GET';
    if (!creating && !joining && !info && !isSocket) return json({error:'Route not found.'}, 404, request, env);
    let body = {};
    if (creating || joining) {
        if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json({error:'Send a JSON request.'}, 400, request, env);
        const text = await request.text();
        if (text.length > 2048) return json({error:'Request too large.'}, 413, request, env);
        try {body = JSON.parse(text);} catch {return json({error:'Invalid JSON.'}, 400, request, env);}
        if (!object(body)) return json({error:'Invalid room request.'}, 400, request, env);
    }
    const roomId = suppliedId || token();
    const stub = env.FOOTBALL_ROOMS.get(env.FOOTBALL_ROOMS.idFromName(roomId));
    let internal;
    if (isSocket) {
        // Forward only the handshake and origin; account credentials are not needed
        // after the one-use ticket has been issued by the trusted HTTP join path.
        const headers = new Headers();
        for (const name of ['Origin', 'Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol']) {
            const value = request.headers.get(name); if (value) headers.set(name, value);
        }
        internal = new Request('https://football.internal/socket' + url.search, {headers});
    } else if (info) internal = new Request('https://football.internal/info');
    else {
        const trusted = identity && typeof identity.username === 'string' ? {username:identity.username, bonkId:String(identity.bonkId ?? identity.bonk_id ?? '')} : null;
        internal = new Request('https://football.internal/' + (creating ? 'create' : 'join'), {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({roomId, name:body.name, displayName:body.displayName, resumeToken:body.resumeToken, identity:trusted})});
    }
    const response = await stub.fetch(internal);
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store'); headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || request.headers.get('Origin') || '');
    headers.set('Access-Control-Allow-Credentials', 'true');
    return new Response(response.body, {status:response.status, headers});
}
