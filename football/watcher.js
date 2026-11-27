// Public viewing never reserves a place, votes, or receives room chat.
export class FootballWatcher {
    constructor({api, onRoom, onSnapshot, onStatus}) {
        this.api = api; this.onRoom = onRoom; this.onSnapshot = onSnapshot; this.onStatus = onStatus;
        this.generation = 0; this.active = false; this.socket = null; this.retry = null; this.ping = null; this.attempt = 0;
    }

    start() {
        if (this.active || !this.api) return;
        this.active = true; this.attempt = 0; this.connect();
    }

    connect() {
        if (!this.active) return;
        const generation = ++this.generation;
        const url = new URL('/api/football/watch', this.api);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url); this.socket = socket;
        socket.addEventListener('open', () => {
            if (generation !== this.generation || !this.active) return;
            this.attempt = 0; this.onStatus?.(true);
            this.ping = setInterval(() => {if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'ping', sentAt: performance.now()}));}, 2000);
        });
        socket.addEventListener('message', event => {
            if (generation !== this.generation || !this.active || typeof event.data !== 'string') return;
            let message; try {message = JSON.parse(event.data);} catch {return;}
            if ((message.type === 'watch' || message.type === 'room') && message.room) this.onRoom?.(message.room);
            else if (message.type === 'snapshot') this.onSnapshot?.(message);
        });
        socket.addEventListener('close', () => {
            if (generation !== this.generation || !this.active) return;
            clearInterval(this.ping); this.ping = null; this.onStatus?.(false);
            this.retry = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** Math.min(4, this.attempt++)));
        });
        socket.addEventListener('error', () => {if (generation === this.generation) this.onStatus?.(false);});
    }

    stop() {
        this.active = false; this.generation++;
        clearTimeout(this.retry); clearInterval(this.ping); this.retry = null; this.ping = null;
        this.socket?.close(1000, 'Finished viewing'); this.socket = null;
    }
}
