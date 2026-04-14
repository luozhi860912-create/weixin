import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const EXT = "WeChatSim";

// ==================== 默认设置 ====================
const DEFAULTS = {
    apiEndpoint: "", apiKey: "", modelId: "", availableModels: [],
    maxTokens: 2048, temperature: 0.85,
    playerName: "我", playerAvatar: "", playerPersona: "",
    playerId: "wxid_player", playerSignature: "",
    walletBalance: 8888.88, backpack: [],
    friends: [], groups: [],
    chatHistories: {}, moments: [],
    followedOA: [], shoppingCart: [],
    forumCache: [], isOpen: false, unreadCount: 0,
    momentBg: "",
};

// ==================== 状态管理 ====================
const S = {
    _s: {},
    init() {
        if (!extension_settings[EXT]) extension_settings[EXT] = {};
        this._s = extension_settings[EXT];
        for (const k in DEFAULTS) {
            if (this._s[k] === undefined) this._s[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
        }
        this.save();
    },
    save() { saveSettingsDebounced(); },
    get(k) { return this._s[k]; },
    set(k, v) { this._s[k] = v; this.save(); },

    getHistory(id) {
        if (!this._s.chatHistories[id]) this._s.chatHistories[id] = [];
        return this._s.chatHistories[id];
    },
    addMsg(chatId, msg) {
        const h = this.getHistory(chatId);
        msg.id = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        msg.timestamp = Date.now();
        h.push(msg);
        this.save();
        return msg;
    },
    getFriend(id) { return this._s.friends.find(f => f.id === id); },
    getFriendByName(n) { return this._s.friends.find(f => f.name === n); },
    getGroup(id) { return this._s.groups.find(g => g.id === id); },
    addFriend(f) {
        if (!this._s.friends.find(x => x.id === f.id)) { this._s.friends.push(f); this.save(); }
    },
    removeFriend(id) {
        this._s.friends = this._s.friends.filter(f => f.id !== id);
        delete this._s.chatHistories[id]; this.save();
    },
    addBackpack(item) {
        const ex = this._s.backpack.find(i => i.name === item.name);
        if (ex) ex.count = (ex.count || 1) + (item.count || 1);
        else { item.count = item.count || 1; this._s.backpack.push(item); }
        this.save();
    },
    removeBackpack(name, n = 1) {
        const it = this._s.backpack.find(i => i.name === name);
        if (!it) return false;
        it.count -= n;
        if (it.count <= 0) this._s.backpack = this._s.backpack.filter(i => i.name !== name);
        this.save(); return true;
    }
};

// ==================== 世界书读取（只读当前角色） ====================
const WB = {
    async getEntries() {
        try {
            const ctx = getContext();
            if (ctx && ctx.worldInfo) return ctx.worldInfo;
            if (typeof window.SillyTavern !== 'undefined') {
                const wi = window.SillyTavern?.getContext?.()?.worldInfo;
                if (wi) return wi;
            }
        } catch (e) { console.warn("WB read fail", e); }
        return [];
    },
    async findEntry(keyword) {
        const entries = await this.getEntries();
        return entries.find(e =>
            e.key && (Array.isArray(e.key) ? e.key : [e.key]).some(k =>
                k.toLowerCase().includes(keyword.toLowerCase())
            )
        );
    },
    async getCharData(name) {
        const entry = await this.findEntry(name);
        if (!entry || !entry.content) return null;
        return this.parse(entry.content);
    },
    parse(content) {
        const d = { raw: content };
        const m = (r) => { const x = content.match(r); return x ? x[1].trim() : null; };
        d.avatar = m(/头像[：:]\s*(.+)/);
        const photos = m(/照片[：:]\s*(.+)/);
        d.photos = photos ? photos.split(/[,，\s]+/).filter(Boolean) : [];
        const vids = m(/视频[：:]\s*(.+)/);
        d.videos = vids ? vids.split(/[,，\s]+/).filter(Boolean) : [];
        d.persona = m(/人设[：:]\s*(.+)/);
        d.chatStyle = m(/聊天风格[：:]\s*(.+)/);
        d.name = m(/姓名[：:]\s*(.+)/) || m(/名[：:]\s*(.+)/);
        d.signature = m(/签名[：:]\s*(.+)/);
        return d;
    },
    async getMedia(name, type) {
        const d = await this.getCharData(name);
        if (!d) return null;
        if (type === 'avatar') return d.avatar;
        if (type === 'photo' && d.photos.length) return d.photos[Math.floor(Math.random() * d.photos.length)];
        if (type === 'video' && d.videos.length) return d.videos[Math.floor(Math.random() * d.videos.length)];
        return null;
    },
    async getAllCharacterNames() {
        const entries = await this.getEntries();
        const names = [];
        entries.forEach(e => {
            if (e.key) {
                const keys = Array.isArray(e.key) ? e.key : [e.key];
                keys.forEach(k => { if (k.trim()) names.push(k.trim()); });
            }
        });
        return [...new Set(names)];
    }
};

// ==================== API ====================
const API = {
    getBase() {
        let ep = (S.get('apiEndpoint') || '').trim().replace(/\/+$/, '');
        if (!ep) return '';
        if (ep.endsWith('/v1')) return ep;
        return ep + '/v1';
    },
    async fetchModels() {
        const base = this.getBase();
        const key = S.get('apiKey');
        if (!base || !key) return [];
        try {
            const r = await fetch(`${base}/models`, {
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
            });
            if (!r.ok) { console.error('Models fetch fail:', r.status); return []; }
            const d = await r.json();
            let models = [];
            if (d.data && Array.isArray(d.data)) models = d.data.map(m => ({ id: m.id, name: m.id }));
            else if (Array.isArray(d)) models = d.map(m => ({ id: m.id || m, name: m.id || m }));
            else if (d.models) models = d.models.map(m => ({ id: m.id || m.name, name: m.id || m.name }));
            S.set('availableModels', models);
            return models;
        } catch (e) { console.error('Models fetch error:', e); return []; }
    },
    async gen(sysPrompt, msgs, opts = {}) {
        const base = this.getBase();
        const key = S.get('apiKey');
        const model = S.get('modelId');
        if (!base || !key || !model) return '请先在设置中配置API。';
        try {
            const r = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model, stream: false,
                    max_tokens: opts.maxTokens || S.get('maxTokens'),
                    temperature: opts.temperature || S.get('temperature'),
                    messages: [{ role: 'system', content: sysPrompt }, ...msgs]
                })
            });
            const d = await r.json();
            return d.choices?.[0]?.message?.content || '生成失败';
        } catch (e) { return 'API错误: ' + e.message; }
    },
    parseJSON(raw) {
        let c = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
        try { return JSON.parse(c); } catch { return null; }
    },

    async chatReply(chatId, isGroup) {
        const history = S.getHistory(chatId);
        const recent = history.slice(-40);
        const ctx = getContext();
        let charCard = '';
        try {
            if (ctx?.characters) {
                const ch = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : ctx.characters;
                if (ch) charCard = ch.description || '';
            }
        } catch (e) { }

        let wbInfo = '';
        try {
            const entries = await WB.getEntries();
            if (entries.length > 0) {
                wbInfo = entries.slice(0, 10).map(e => {
                    const keys = Array.isArray(e.key) ? e.key.join(',') : e.key;
                    return `[${keys}]: ${(e.content || '').substring(0, 200)}`;
                }).join('\n');
            }
        } catch (e) { }

        let chatInfo = '';
        if (isGroup) {
            const g = S.getGroup(chatId);
            if (g) chatInfo = `群聊"${g.name}"，成员：${g.members.map(m => m.name).join('、')}`;
        } else {
            const f = S.getFriend(chatId);
            if (f) {
                chatInfo = `与"${f.name}"私聊`;
                if (f.persona) chatInfo += `\n好友人设：${f.persona}`;
                if (f.chatStyle) chatInfo += `\n聊天风格：${f.chatStyle}`;
            }
        }

        const progressSummary = recent.map(m =>
            `[${m.sender}](${m.type}): ${m.type === 'text' ? m.content : m.type}`
        ).join('\n');

        const sys = `你是微信聊天模拟AI。扮演联系人回复。

角色卡设定：
${charCard.substring(0, 800)}

世界书信息：
${wbInfo.substring(0, 1000)}

当前聊天：${chatInfo}

玩家：${S.get('playerName')}
玩家人设：${S.get('playerPersona')}

聊天进度记录：
${progressSummary}

回复规则：
1. 模拟真实微信聊天风格，口语化
2. 参考角色卡和世界书中的聊天风格
3. 根据聊天进度和上下文连贯回复
4. 回复JSON格式，可多条：
[
  {"type":"text","content":"内容","sender":"角色名"},
  {"type":"image","url":"世界书中的真实图片链接","sender":"角色名"},
  {"type":"pat","sender":"拍的人","target":"被拍的人"},
  {"type":"redpacket","sender":"角色名","greeting":"祝福语","amount":金额数字}
]
5. 图片url请使用世界书中该角色照片字段的真实链接
6. 群聊可多个不同sender回复
7. 只输出JSON数组`;

        const apiMsgs = recent.slice(-20).map(m => ({
            role: m.sender === S.get('playerName') ? 'user' : 'assistant',
            content: `[${m.sender}](${m.type}): ${m.type === 'text' ? m.content : m.type}`
        }));

        const raw = await this.gen(sys, apiMsgs);
        const parsed = this.parseJSON(raw);
        if (parsed) return Array.isArray(parsed) ? parsed : [parsed];
        return [{ type: 'text', content: raw, sender: this.defaultSender(chatId, isGroup) }];
    },

    defaultSender(chatId, isGroup) {
        if (isGroup) {
            const g = S.getGroup(chatId);
            if (g?.members?.length) {
                const np = g.members.filter(m => m.name !== S.get('playerName'));
                return np.length ? np[Math.floor(Math.random() * np.length)].name : g.members[0].name;
            }
            return '群友';
        }
        const f = S.getFriend(chatId);
        return f ? f.name : '对方';
    },

    async momentComments(text) {
        const friends = S.get('friends').slice(0, 10);
        const names = friends.map(f => f.name).join('、');
        const entries = await WB.getEntries();
        let wbRef = entries.slice(0, 5).map(e => {
            const k = Array.isArray(e.key) ? e.key.join(',') : e.key;
            return `[${k}]:${(e.content || '').substring(0, 100)}`;
        }).join('\n');

        const sys = `玩家"${S.get('playerName')}"发朋友圈："${text}"
好友：${names || '暂无好友'}
参考世界书：${wbRef}
生成JSON：{"likes":["点赞人名"],"comments":[{"sender":"人名","content":"评论","image":"可选图片链接"}]}
评论要符合每个人性格，参考世界书。只输出JSON。`;
        const raw = await this.gen(sys, []);
        const p = this.parseJSON(raw);
        return p || { likes: [], comments: [] };
    },

    async generateFriendInfo(name) {
        const wbData = await WB.getCharData(name);
        const entries = await WB.getEntries();
        let wbContext = entries.slice(0, 8).map(e => {
            const k = Array.isArray(e.key) ? e.key.join(',') : e.key;
            return `[${k}]:${(e.content || '').substring(0, 200)}`;
        }).join('\n');

        const sys = `世界书信息：
${wbContext}

${wbData ? `该角色世界书条目：\n${wbData.raw}` : `世界书中没有找到"${name}"的条目。`}

请根据世界书内容，生成角色"${name}"的微信好友信息，JSON格式：
{
  "name": "${name}",
  "avatar": "头像图片链接(优先使用世界书中的链接)",
  "persona": "角色人设描述(根据世界书)",
  "chatStyle": "聊天风格",
  "signature": "个性签名",
  "photos": ["照片链接数组(使用世界书中的)"]
}
如果世界书有图片链接就使用真实链接，没有就用空字符串。只输出JSON。`;

        const raw = await this.gen(sys, []);
        const p = this.parseJSON(raw);
        return p;
    },

    async searchOA(query) {
        const sys = `搜索公众号："${query}"
生成3-5个JSON数组：[{"name":"名称","desc":"简介","avatar":"emoji"}]
只输出JSON。`;
        const raw = await this.gen(sys, []);
        return this.parseJSON(raw) || [{ name: query + '资讯', desc: '关注获取最新资讯', avatar: '📰' }];
    },

    async genArticles(name) {
        const sys = `公众号"${name}"推送文章。
生成3篇JSON数组：[{"title":"标题","summary":"摘要","content":"完整内容200-500字","readCount":数字}]
只输出JSON。`;
        const raw = await this.gen(sys, []);
        return this.parseJSON(raw) || [{ title: '文章', summary: '点击查看', content: '加载失败', readCount: 100 }];
    },

    async genShopItems(keyword = '') {
        const entries = await WB.getEntries();
        let ref = entries.slice(0, 5).map(e => (e.content || '').substring(0, 100)).join('\n');
        const sys = `${keyword ? '搜索商品关键词："' + keyword + '"' : '生成推荐商品'}
参考设定：${ref}
生成6-8个JSON数组：[{"name":"商品名","price":价格,"desc":"描述","emoji":"emoji","category":"分类"}]
只输出JSON。`;
        const raw = await this.gen(sys, []);
        return this.parseJSON(raw) || [{ name: '神秘礼盒', price: 99, desc: '惊喜', emoji: '🎁', category: '礼物' }];
    },

    async genForumPosts(keyword = '') {
        const friends = S.get('friends').slice(0, 8);
        const names = friends.map(f => f.name).join('、') || '路人甲、路人乙';
        const entries = await WB.getEntries();
        let ref = entries.slice(0, 5).map(e => (e.content || '').substring(0, 100)).join('\n');

        const sys = `${keyword ? '搜索论坛帖子："' + keyword + '"，生成相关帖子' : '生成论坛帖子'}
论坛用户：${names}
参考设定：${ref}
生成4-6条帖子，每条含回复。JSON数组：
[{
  "author":"发帖人",
  "title":"标题",
  "content":"内容50-150字",
  "likes":数字,
  "time":"时间描述",
  "replies":[
    {"author":"回复人","content":"回复内容","time":"时间","likes":数字}
  ]
}]
帖子风格参考世界书设定。只输出JSON。`;
        const raw = await this.gen(sys, []);
        return this.parseJSON(raw) || [{ author: '系统', title: '欢迎', content: '论坛', likes: 0, time: '刚刚', replies: [] }];
    }
};

// ==================== 工具 ====================
const U = {
    time() {
        const n = new Date();
        return `${n.getHours().toString().padStart(2, '0')}:${n.getMinutes().toString().padStart(2, '0')}`;
    },
    fmtTime(ts) {
        if (!ts) return '';
        const d = new Date(ts), now = new Date(), diff = now - d;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
        if (diff < 86400000) return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        return `${d.getMonth() + 1}/${d.getDate()}`;
    },
    fmtMsgTime(ts) {
        if (!ts) return '';
        const d = new Date(ts), now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const t = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        return isToday ? t : `${d.getMonth() + 1}月${d.getDate()}日 ${t}`;
    },
    hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; } return h; },
    avatar(name = '') {
        const c = ['#07C160', '#FA5151', '#576B95', '#FF8800', '#C44AFF', '#00BFFF'];
        const cl = c[Math.abs(U.hash(name)) % c.length];
        const ini = (name || '?')[0];
        return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="${cl}" width="100" height="100" rx="8"/><text x="50" y="62" fill="white" font-size="45" font-family="Arial" text-anchor="middle" font-weight="bold">${ini}</text></svg>`)}`;
    },
    esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
    escAttr(s) { return (s || '').replace(/'/g, "\\'").replace(/"/g, '\\"'); },
    readFile(file) {
        return new Promise((resolve) => {
            const r = new FileReader();
            r.onload = e => resolve(e.target.result);
            r.readAsDataURL(file);
        });
    }
};

// ==================== SVG图标 ====================
const IC = {
    wechat: `<svg viewBox="0 0 24 24"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 01.213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.328.328 0 00.167-.054l1.903-1.114a.864.864 0 01.717-.098 10.16 10.16 0 002.837.403c.276 0 .543-.027.811-.05a6.577 6.577 0 01-.253-1.82c0-3.697 3.37-6.694 7.527-6.694.259 0 .508.025.764.042C16.833 4.905 13.147 2.188 8.691 2.188zm-2.87 4.401a1.026 1.026 0 11-.001 2.052 1.026 1.026 0 010-2.052zm5.742 0a1.026 1.026 0 110 2.052 1.026 1.026 0 010-2.052zm4.198 2.908c-3.732 0-6.759 2.654-6.759 5.93 0 3.274 3.027 5.93 6.76 5.93.867 0 1.7-.143 2.47-.402a.73.73 0 01.604.083l1.61.943a.276.276 0 00.142.046c.134 0 .244-.111.244-.248 0-.06-.024-.12-.04-.18l-.33-1.252a.498.498 0 01.18-.56C20.88 18.682 21.9 16.906 21.9 15.43c.002-3.278-3.025-5.932-6.759-5.932zm-2.926 3.28a.868.868 0 110 1.735.868.868 0 010-1.735zm5.088 0a.868.868 0 110 1.736.868.868 0 010-1.736z"/></svg>`,
    contacts: `<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
    discover: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`,
    me: `<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    back: `<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`,
    more: `<svg viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>`,
    send: `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
    reply: `<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`,
    upload: `<svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`,
    camera: `<svg viewBox="0 0 24 24"><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>`,
    image: `<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`,
    emoji: `<svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>`,
    mic: `<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>`,
    search: `<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`,
};

// ==================== 主控制器 ====================
class WC {
    constructor() {
        this.phone = null;
        this.page = 'chat-list';
        this.stack = [];
        this.chatId = null;
        this.chatIsGroup = false;
        this.pending = 0;
        this.generating = false;
        this.oaName = '';
        this.oaArticles = [];
        this.currentArticle = null;
        this.shopItems = [];
        this.forumPosts = [];
        this.currentForumPost = null;
        this.momentImgs = [];
        this.contactId = null;
        this.rpDetailMsg = null;
        this.isMobile = false;
    }

    async init() {
        S.init();
        this.build();
        setInterval(() => {
            const t = this.phone?.querySelector('.wc-statusbar .time');
            if (t) t.textContent = U.time();
        }, 30000);
    }

    build() {
        // 清理旧实例
        const old = document.getElementById('wechat-sim-container');
        if (old) old.remove();

        const c = document.createElement('div');
        c.id = 'wechat-sim-container';
        c.innerHTML = `
<div id="wechat-phone"><div class="wc-screen" id="wc-main"></div></div>
<div id="wechat-action-panel">
    <button class="wc-side-btn" id="wc-reply-btn" ontouchend="W.doReply();event.preventDefault();" onclick="W.doReply()">
        ${IC.reply}<span class="btn-label">生成回复</span>
    </button>
    <button class="wc-side-btn" id="wc-upload-btn" ontouchend="W.showUpload();event.preventDefault();" onclick="W.showUpload()">
        ${IC.upload}<span class="btn-label">上传文件</span>
    </button>
    <button class="wc-side-btn" id="wc-settings-btn" ontouchend="W.openSettings();event.preventDefault();" onclick="W.openSettings()">
        ${IC.settings}<span class="btn-label">插件设置</span>
    </button>
</div>
<button id="wechat-toggle-btn" ontouchend="W.toggle();event.preventDefault();" onclick="W.toggle()">
    ${IC.wechat}<span class="badge" style="display:none">0</span>
</button>
<div id="wc-settings-panel"></div>`;

        // 强制插入到 body 最末尾
        document.body.appendChild(c);

        // 移动端检测
        this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
            || window.innerWidth < 768;

        if (this.isMobile) {
            this.ensureVisible(c);
        }

        this.phone = document.getElementById('wechat-phone');
        this.render();

        // 监听窗口变化
        window.addEventListener('resize', () => {
            this.isMobile = window.innerWidth < 768;
        });

        // 延迟多次检测确保按钮可见
        setTimeout(() => this.checkVisibility(), 500);
        setTimeout(() => this.checkVisibility(), 2000);
        setTimeout(() => this.checkVisibility(), 5000);
    }

    ensureVisible(el) {
        let parent = el.parentElement;
        while (parent && parent !== document.body && parent !== document.documentElement) {
            const style = getComputedStyle(parent);
            if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') {
                document.body.appendChild(el);
                return;
            }
            parent = parent.parentElement;
        }
    }

    checkVisibility() {
        const btn = document.getElementById('wechat-toggle-btn');
        if (!btn) return;
        const rect = btn.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0
            && rect.top < window.innerHeight && rect.bottom > 0
            && rect.left < window.innerWidth && rect.right > 0;

        if (!visible) {
            console.warn('WeChatSim: 按钮不可见，尝试修复...');
            const container = document.getElementById('wechat-sim-container');
            if (container) {
                container.style.cssText = `
                    position: fixed !important;
                    right: 10px !important;
                    bottom: ${this.isMobile ? '60px' : '20px'} !important;
                    z-index: 2147483647 !important;
                    display: block !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                    pointer-events: auto !important;
                `;
                btn.style.cssText = `
                    display: flex !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                    pointer-events: auto !important;
                    width: 50px !important;
                    height: 50px !important;
                    border-radius: 50% !important;
                    background: #07C160 !important;
                    border: 2px solid rgba(255,255,255,0.3) !important;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important;
                    align-items: center !important;
                    justify-content: center !important;
                    cursor: pointer !important;
                    z-index: 2147483647 !important;
                    position: relative !important;
                    -webkit-tap-highlight-color: transparent !important;
                    touch-action: manipulation !important;
                `;
                document.body.appendChild(container);
            }
        }
    }

    toggle() {
        const p = this.phone;
        const ap = document.getElementById('wechat-action-panel');
        if (p.classList.contains('active')) {
            p.classList.remove('active');
            ap.classList.remove('visible');
            if (this.isMobile) {
                document.body.style.overflow = '';
                document.body.style.position = '';
                document.body.style.width = '';
            }
        } else {
            p.classList.add('active');
            ap.classList.add('visible');
            if (this.isMobile) {
                document.body.style.overflow = 'hidden';
                document.body.style.position = 'fixed';
                document.body.style.width = '100%';
            }
            this.render();
        }
    }

    render() {
        const m = document.getElementById('wc-main');
        if (!m) return;
        const pg = this.page;
        let h = '';
        if (pg === 'chat-list') h = this.pgChatList();
        else if (pg === 'contacts') h = this.pgContacts();
        else if (pg === 'discover') h = this.pgDiscover();
        else if (pg === 'me') h = this.pgMe();
        else if (pg === 'chat') h = this.pgChat();
        else if (pg === 'moments') h = this.pgMoments();
        else if (pg === 'compose-moment') h = this.pgComposeMoment();
        else if (pg === 'wallet') h = this.pgWallet();
        else if (pg === 'backpack') h = this.pgBackpack();
        else if (pg === 'oa-list') h = this.pgOAList();
        else if (pg === 'oa-detail') h = this.pgOADetail();
        else if (pg === 'article') h = this.pgArticle();
        else if (pg === 'shop') h = this.pgShop();
        else if (pg === 'forum') h = this.pgForum();
        else if (pg === 'forum-detail') h = this.pgForumDetail();
        else if (pg === 'profile') h = this.pgProfile();
        else if (pg === 'persona') h = this.pgPersona();
        else if (pg === 'rp-detail') h = this.pgRPDetail();
        else h = this.pgChatList();
        m.innerHTML = h;
        if (pg === 'chat') { this.scrollChat(); this.updateReplyBtn(); }
        else document.getElementById('wc-reply-btn')?.classList.remove('active-page');
    }

    nav(pg) { this.stack.push(this.page); this.page = pg; this.render(); }
    goBack() { this.page = this.stack.pop() || 'chat-list'; this.render(); }
    switchTab(t) {
        const map = { chats: 'chat-list', contacts: 'contacts', discover: 'discover', me: 'me' };
        this.page = map[t] || 'chat-list'; this.stack = []; this.render();
    }

    // ===== 通用渲染部件 =====
    statusBar() {
        return `<div class="wc-statusbar"><span class="time">${U.time()}</span><span>📶 🔋</span></div>`;
    }
    navbar(title, back = false, actions = '') {
        return `<div class="wc-navbar">${back ? `<button class="nav-back" onclick="W.goBack()">${IC.back}</button>` : '<div></div>'}<div class="nav-title">${title}</div><div class="nav-actions">${actions}</div></div>`;
    }
    tabbar(active = 'chats') {
        const tabs = [
            { id: 'chats', label: '微信', icon: IC.wechat },
            { id: 'contacts', label: '通讯录', icon: IC.contacts },
            { id: 'discover', label: '发现', icon: IC.discover },
            { id: 'me', label: '我', icon: IC.me }
        ];
        return `<div class="wc-tabbar">${tabs.map(t => `
            <button class="wc-tab ${active === t.id ? 'active' : ''}" onclick="W.switchTab('${t.id}')">
                ${t.icon}<span>${t.label}</span>
            </button>`).join('')}</div>`;
    }
    toast(msg) {
        const ex = this.phone?.querySelector('.wc-toast');
        if (ex) ex.remove();
        const t = document.createElement('div');
        t.className = 'wc-toast'; t.textContent = msg;
        this.phone?.querySelector('.wc-screen')?.appendChild(t);
        setTimeout(() => t.remove(), 2200);
    }
    modal(title, body, btns) {
        const o = document.createElement('div');
        o.className = 'wc-overlay';
        o.innerHTML = `<div class="wc-modal">
            ${title ? `<div class="wc-modal-hd">${title}</div>` : ''}
            <div class="wc-modal-bd">${body}</div>
            <div class="wc-modal-ft">${btns.map(b => `<button class="${btns.length === 1 ? 'single' : ''}" onclick="${b.action}">${b.label}</button>`).join('')}</div>
        </div>`;
        this.phone?.querySelector('.wc-screen')?.appendChild(o);
        return o;
    }
    closeModal() {
        const o = this.phone?.querySelector('.wc-overlay');
        if (o) o.remove();
    }
    getAvatar(name, custom) { return custom || U.avatar(name); }
    loading() { return `<div class="wc-loading"><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`; }
    scrollChat() { setTimeout(() => { const c = document.getElementById('chat-msgs'); if (c) c.scrollTop = c.scrollHeight; }, 50); }

    // ==================== 页面: 聊天列表 ====================
    pgChatList() {
        const chats = [];
        S.get('friends').forEach(f => {
            const h = S.getHistory(f.id); const last = h[h.length - 1];
            chats.push({ id: f.id, name: f.name, avatar: f.avatar, lastMsg: last ? (last.type === 'text' ? last.content : `[${last.type}]`) : '', time: last ? U.fmtTime(last.timestamp) : '', ts: last ? last.timestamp : 0, isGroup: false });
        });
        S.get('groups').forEach(g => {
            const h = S.getHistory(g.id); const last = h[h.length - 1];
            chats.push({ id: g.id, name: g.name, avatar: g.avatar, lastMsg: last ? `${last.sender || ''}: ${last.type === 'text' ? last.content : `[${last.type}]`}` : '', time: last ? U.fmtTime(last.timestamp) : '', ts: last ? last.timestamp : 0, isGroup: true });
        });
        chats.sort((a, b) => b.ts - a.ts);

        return `${this.statusBar()}
${this.navbar('微信', false, `<button onclick="W.showAddMenu()">${IC.plus}</button>`)}
<div class="wc-screen"><div class="wc-screen-body">
    <div class="wc-search-bar"><input placeholder="搜索" oninput="W.searchChats(this.value)"/></div>
    <div id="chat-items">
        ${chats.map(c => `
        <div class="chat-list-item" onclick="W.openChat('${c.id}',${c.isGroup})">
            <img class="avatar" src="${this.getAvatar(c.name, c.avatar)}" onerror="this.src='${U.avatar(c.name)}'"/>
            <div class="chat-info">
                <div class="chat-name"><span class="name-text">${c.name}</span><span class="chat-time">${c.time}</span></div>
                <div class="chat-preview">${U.esc(c.lastMsg).substring(0, 30)}</div>
            </div>
        </div>`).join('')}
        ${chats.length === 0 ? '<div style="text-align:center;padding:40px;color:#999;">暂无聊天<br>点击右上角 + 添加好友</div>' : ''}
    </div>
</div></div>
${this.tabbar('chats')}`;
    }

    searchChats(q) {
        document.querySelectorAll('#chat-items .chat-list-item').forEach(el => {
            const n = el.querySelector('.name-text')?.textContent || '';
            el.style.display = n.includes(q) ? 'flex' : 'none';
        });
    }

    // ==================== 页面: 聊天 ====================
    pgChat() {
        const isG = this.chatIsGroup;
        const info = isG ? S.getGroup(this.chatId) : S.getFriend(this.chatId);
        if (!info) return this.pgChatList();
        const history = S.getHistory(this.chatId);
        const title = info.name + (isG ? ` (${info.members?.length || 0})` : '');
        const pName = S.get('playerName');

        const msgs = history.map((msg, i) => {
            const isSelf = msg.sender === pName;
            let senderInfo = null;
            if (isG && !isSelf && info.members) {
                senderInfo = info.members.find(m => m.name === msg.sender);
            }
            const av = isSelf
                ? this.getAvatar(pName, S.get('playerAvatar'))
                : (senderInfo?.avatar || info.avatar || U.avatar(msg.sender || info.name));

            let timeLbl = '';
            if (i === 0 || (msg.timestamp - history[i - 1].timestamp > 300000))
                timeLbl = `<div class="chat-time-label">${U.fmtMsgTime(msg.timestamp)}</div>`;

            if (msg.type === 'system') return `${timeLbl}<div class="chat-system-msg">${U.esc(msg.content)}</div>`;
            if (msg.type === 'pat') return `${timeLbl}<div class="chat-pat-msg">"${msg.sender}" 拍了拍 "${msg.target}"</div>`;

            if (msg.type === 'redpacket') {
                return `${timeLbl}<div class="msg-row ${isSelf ? 'self' : ''}">
                    <img class="msg-avatar" src="${av}" onerror="this.src='${U.avatar(msg.sender || '')}'"/>
                    <div class="msg-wrap">${!isSelf && isG ? `<div class="msg-sender">${msg.sender}</div>` : ''}
                        <div class="msg-bubble rp-msg ${msg.opened ? 'opened' : ''}" onclick="W.openRP('${msg.id}','${this.chatId}')">
                            <div class="rp-body"><div class="rp-icon">🧧</div><div class="rp-text">${U.esc(msg.greeting || '恭喜发财')}</div></div>
                            <div class="rp-footer">微信红包${msg.opened ? ' · 已领取' : ''}</div>
                        </div>
                    </div></div>`;
            }
            if (msg.type === 'gift') {
                return `${timeLbl}<div class="msg-row ${isSelf ? 'self' : ''}">
                    <img class="msg-avatar" src="${av}" onerror="this.src='${U.avatar(msg.sender || '')}'"/>
                    <div class="msg-wrap">${!isSelf && isG ? `<div class="msg-sender">${msg.sender}</div>` : ''}
                        <div class="msg-bubble gift-msg"><div class="g-icon">${msg.emoji || '🎁'}</div><div class="g-name">${U.esc(msg.giftName || '礼物')}</div><div class="g-desc">${U.esc(msg.content || '')}</div></div>
                    </div></div>`;
            }
            if (msg.type === 'image') {
                return `${timeLbl}<div class="msg-row ${isSelf ? 'self' : ''}">
                    <img class="msg-avatar" src="${av}" onerror="this.src='${U.avatar(msg.sender || '')}'"/>
                    <div class="msg-wrap">${!isSelf && isG ? `<div class="msg-sender">${msg.sender}</div>` : ''}
                        <div class="msg-bubble img-msg"><img src="${msg.url}" onerror="this.alt='图片加载失败'" onclick="W.viewImg('${U.escAttr(msg.url)}')"/></div>
                    </div></div>`;
            }
            if (msg.type === 'video') {
                return `${timeLbl}<div class="msg-row ${isSelf ? 'self' : ''}">
                    <img class="msg-avatar" src="${av}" onerror="this.src='${U.avatar(msg.sender || '')}'"/>
                    <div class="msg-wrap">${!isSelf && isG ? `<div class="msg-sender">${msg.sender}</div>` : ''}
                        <div class="msg-bubble vid-msg" onclick="W.playVid('${U.escAttr(msg.url)}')">
                            <video src="${msg.url}" preload="metadata"></video>
                            <div class="play-icon">${IC.play}</div>
                        </div>
                    </div></div>`;
            }

            let content = U.esc(msg.content || '');
            content = content.replace(/@(\S+)/g, '<span class="at-mention">@$1</span>');
            return `${timeLbl}<div class="msg-row ${isSelf ? 'self' : ''}">
                <img class="msg-avatar" src="${av}" onerror="this.src='${U.avatar(msg.sender || '')}'" onclick="W.viewProfile('${U.escAttr(msg.sender || '')}')"/>
                <div class="msg-wrap">${!isSelf && isG ? `<div class="msg-sender">${msg.sender}</div>` : ''}
                    <div class="msg-bubble">${content}</div>
                </div></div>`;
        }).join('');

        return `${this.statusBar()}
${this.navbar(title, true, `<button onclick="W.chatMenu('${this.chatId}',${isG})">${IC.more}</button>`)}
<div class="wc-screen" style="display:flex;flex-direction:column;">
    <div class="wc-chat-messages" id="chat-msgs">${msgs}</div>
    <div class="wc-input-bar">
        <div class="input-left"><button onclick="W.toggleEmoji()">${IC.emoji}</button></div>
        <textarea class="chat-input" id="chat-inp" rows="1" placeholder="输入消息..." oninput="W.onInp(this)" onkeydown="W.onKey(event)"></textarea>
        <div class="input-right">
            <button onclick="W.toggleMore()">${IC.plus}</button>
            <button class="send-btn" id="send-btn" onclick="W.sendMsg()">发送</button>
        </div>
    </div>
    <div class="more-panel" id="more-panel">
        <div class="more-item" onclick="W.sendPhoto()"><div class="more-icon">📷</div><span>照片</span></div>
        <div class="more-item" onclick="W.sendVideo()"><div class="more-icon">🎬</div><span>视频</span></div>
        <div class="more-item" onclick="W.sendRP()"><div class="more-icon">🧧</div><span>红包</span></div>
        <div class="more-item" onclick="W.sendGift()"><div class="more-icon">🎁</div><span>礼物</span></div>
        <div class="more-item" onclick="W.doPat()"><div class="more-icon">👋</div><span>拍一拍</span></div>
        ${isG ? '<div class="more-item" onclick="W.atSomeone()"><div class="more-icon">@</div><span>@某人</span></div>' : ''}
        <div class="more-item" onclick="W.sendFromBP()"><div class="more-icon">🎒</div><span>背包</span></div>
    </div>
</div>`;
    }

    onInp(ta) {
        const btn = document.getElementById('send-btn');
        if (ta.value.trim()) btn?.classList.add('visible');
        else btn?.classList.remove('visible');
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
    }
    onKey(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMsg(); }
    }
    sendMsg() {
        const inp = document.getElementById('chat-inp');
        const text = inp?.value?.trim();
        if (!text) return;
        S.addMsg(this.chatId, { type: 'text', content: text, sender: S.get('playerName') });
        inp.value = ''; inp.style.height = 'auto';
        document.getElementById('send-btn')?.classList.remove('visible');
        this.pending++;
        this.render();
    }
    toggleMore() { document.getElementById('more-panel')?.classList.toggle('visible'); }

    updateReplyBtn() {
        const btn = document.getElementById('wc-reply-btn');
        if (!btn) return;
        const lbl = btn.querySelector('.btn-label');
        if (lbl) {
            if (this.page === 'chat' && this.pending > 0) {
                lbl.textContent = `生成回复(${this.pending})`;
            } else {
                lbl.textContent = '生成回复';
            }
        }
    }

    // ===== 手机外回复按钮 =====
    async doReply() {
        if (this.generating) return;
        if (this.page === 'chat') {
            await this.doChatReply();
        } else if (this.page === 'moments') {
            this.toast('朋友圈回复在发布时自动生成');
        } else if (this.page === 'forum') {
            await this.refreshForum();
        } else {
            this.toast('请先进入聊天页面');
        }
    }

    async doChatReply() {
        if (!this.chatId) { this.toast('请先打开聊天'); return; }
        this.generating = true;
        const btn = document.getElementById('wc-reply-btn');
        btn?.classList.add('loading');

        try {
            const replies = await API.chatReply(this.chatId, this.chatIsGroup);
            for (const r of replies) {
                const sender = r.sender || API.defaultSender(this.chatId, this.chatIsGroup);
                if (r.type === 'pat') {
                    S.addMsg(this.chatId, { type: 'pat', sender: r.sender || sender, target: r.target || S.get('playerName') });
                } else if (r.type === 'redpacket') {
                    S.addMsg(this.chatId, { type: 'redpacket', sender, greeting: r.greeting || '恭喜发财', amount: r.amount || Math.random() * 10, opened: false });
                } else if (r.type === 'image') {
                    let url = r.url || '';
                    if (!url || url.includes('描述')) {
                        const wbUrl = await WB.getMedia(sender, 'photo');
                        if (wbUrl) url = wbUrl;
                    }
                    S.addMsg(this.chatId, { type: 'image', url, sender });
                } else {
                    S.addMsg(this.chatId, { type: 'text', content: r.content || r.text || '', sender });
                }
            }
            this.pending = 0;
            this.render();
        } catch (e) { this.toast('生成失败: ' + e.message); }

        this.generating = false;
        btn?.classList.remove('loading');
        this.updateReplyBtn();
    }

    // ===== 上传功能 =====
    showUpload() {
        const body = `
<div style="font-size:14px;margin-bottom:12px;">选择上传用途：</div>
<div class="friend-list">
    <div class="friend-row" onclick="W.uploadFor('chat-photo')">📷 <span class="fr-name">聊天图片</span></div>
    <div class="friend-row" onclick="W.uploadFor('chat-video')">🎬 <span class="fr-name">聊天视频</span></div>
    <div class="friend-row" onclick="W.uploadFor('my-avatar')">👤 <span class="fr-name">我的头像</span></div>
    <div class="friend-row" onclick="W.uploadFor('friend-avatar')">👥 <span class="fr-name">好友头像</span></div>
    <div class="friend-row" onclick="W.uploadFor('moment-img')">🌅 <span class="fr-name">朋友圈图片</span></div>
    <div class="friend-row" onclick="W.uploadFor('moment-bg')">🎨 <span class="fr-name">朋友圈背景</span></div>
</div>`;
        this.modal('上传文件', body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }

    uploadFor(purpose) {
        this.closeModal();
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = purpose.includes('video') ? 'video/*' : 'image/*,image/gif';
        inp.onchange = async (e) => {
            if (!e.target.files.length) return;
            const data = await U.readFile(e.target.files[0]);
            switch (purpose) {
                case 'chat-photo':
                    if (this.page === 'chat' && this.chatId) {
                        S.addMsg(this.chatId, { type: 'image', url: data, sender: S.get('playerName') });
                        this.pending++; this.render();
                    } else this.toast('请先打开聊天');
                    break;
                case 'chat-video':
                    if (this.page === 'chat' && this.chatId) {
                        S.addMsg(this.chatId, { type: 'video', url: data, sender: S.get('playerName') });
                        this.pending++; this.render();
                    } else this.toast('请先打开聊天');
                    break;
                case 'my-avatar':
                    S.set('playerAvatar', data);
                    this.toast('头像已更新'); this.render();
                    break;
                case 'friend-avatar':
                    this.selectFriendForAvatar(data);
                    break;
                case 'moment-img':
                    this.momentImgs.push(data);
                    if (this.page === 'compose-moment') this.render();
                    else this.toast('图片已暂存，去朋友圈发表时使用');
                    break;
                case 'moment-bg':
                    S.set('momentBg', data);
                    this.toast('朋友圈背景已更新');
                    break;
            }
        };
        inp.click();
    }

    selectFriendForAvatar(data) {
        const friends = S.get('friends');
        if (!friends.length) { this.toast('暂无好友'); return; }
        const body = `<div class="friend-list">${friends.map(f => `
            <div class="friend-row" onclick="W.setFriendAvatar('${f.id}','${U.escAttr(data)}')">
                <img class="fr-avatar" src="${this.getAvatar(f.name, f.avatar)}" onerror="this.src='${U.avatar(f.name)}'"/>
                <span class="fr-name">${f.name}</span>
            </div>`).join('')}</div>`;
        this.modal('选择好友', body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }
    setFriendAvatar(fid, data) {
        const f = S.getFriend(fid);
        if (f) { f.avatar = data; S.save(); this.toast('已更新'); }
        this.closeModal();
    }

    // ===== 发送照片/视频 =====
    sendPhoto() {
        const body = `<div>
            <label style="font-size:14px">图片链接：</label>
            <input class="wc-input" id="ph-url" placeholder="输入链接"/>
            <label style="font-size:14px;margin-top:8px;display:block;">或上传：</label>
            <input type="file" accept="image/*,image/gif" id="ph-file" style="font-size:14px;"/>
        </div>`;
        this.modal('发送照片', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '发送', action: 'W.doSendPhoto()' }
        ]);
    }
    async doSendPhoto() {
        const url = document.getElementById('ph-url')?.value?.trim();
        const fi = document.getElementById('ph-file');
        let src = url;
        if (!src && fi?.files?.length) src = await U.readFile(fi.files[0]);
        if (!src) { this.toast('请输入链接或选择文件'); return; }
        S.addMsg(this.chatId, { type: 'image', url: src, sender: S.get('playerName') });
        this.closeModal(); this.pending++; this.render();
    }

    sendVideo() {
        const body = `<div>
            <label style="font-size:14px">视频链接：</label>
            <input class="wc-input" id="vid-url" placeholder="输入链接"/>
            <label style="font-size:14px;margin-top:8px;display:block;">或上传：</label>
            <input type="file" accept="video/*" id="vid-file" style="font-size:14px;"/>
        </div>`;
        this.modal('发送视频', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '发送', action: 'W.doSendVideo()' }
        ]);
    }
    async doSendVideo() {
        const url = document.getElementById('vid-url')?.value?.trim();
        const fi = document.getElementById('vid-file');
        let src = url;
        if (!src && fi?.files?.length) src = await U.readFile(fi.files[0]);
        if (!src) return;
        S.addMsg(this.chatId, { type: 'video', url: src, sender: S.get('playerName') });
        this.closeModal(); this.pending++; this.render();
    }

    // ===== 红包 =====
    sendRP() {
        const isG = this.chatIsGroup;
        const body = `<div>
            <label style="font-size:14px">金额：</label>
            <input class="wc-input" id="rp-amt" type="number" value="6.66" step="0.01" min="0.01" max="200"/>
            <label style="font-size:14px">祝福语：</label>
            <input class="wc-input" id="rp-greet" value="恭喜发财，大吉大利"/>
            ${isG ? `<label style="font-size:14px">类型：</label>
            <select class="wc-select" id="rp-type"><option value="normal">普通红包</option><option value="lucky">拼手气红包</option></select>
            <label style="font-size:14px">个数：</label>
            <input class="wc-input" id="rp-cnt" type="number" value="5" min="1" max="20"/>` : ''}
        </div>`;
        this.modal('发红包', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '塞钱进红包', action: 'W.doSendRP()' }
        ]);
    }
    doSendRP() {
        const amt = parseFloat(document.getElementById('rp-amt')?.value) || 6.66;
        const greet = document.getElementById('rp-greet')?.value || '恭喜发财';
        const type = document.getElementById('rp-type')?.value || 'normal';
        const cnt = parseInt(document.getElementById('rp-cnt')?.value) || 5;
        if (amt > S.get('walletBalance')) { this.toast('余额不足'); return; }
        S.set('walletBalance', S.get('walletBalance') - amt);
        const msg = { type: 'redpacket', sender: S.get('playerName'), greeting: greet, amount: amt, opened: false, rpType: type };
        if (this.chatIsGroup && type === 'lucky') { msg.rpCount = cnt; msg.totalAmount = amt; msg.isGroupRp = true; }
        S.addMsg(this.chatId, msg);
        this.closeModal(); this.pending++; this.render();
    }

    openRP(msgId, chatId) {
        const h = S.getHistory(chatId);
        const msg = h.find(m => m.id === msgId);
        if (!msg) return;
        if (msg.opened) {
            this.rpDetailMsg = msg;
            this.nav('rp-detail');
            return;
        }
        if (msg.isGroupRp && msg.rpType === 'lucky') {
            this.openLuckyRP(msg, chatId);
            return;
        }
        msg.opened = true;
        if (msg.sender !== S.get('playerName')) {
            S.set('walletBalance', S.get('walletBalance') + msg.amount);
        }
        S.save();
        this.rpDetailMsg = msg;
        this.nav('rp-detail');
    }

    openLuckyRP(msg, chatId) {
        const g = S.getGroup(chatId);
        if (!g) return;
        const members = g.members.map(m => m.name);
        const count = Math.min(msg.rpCount || 5, members.length);
        const total = msg.totalAmount || msg.amount;
        let amounts = [], remaining = total;
        for (let i = 0; i < count - 1; i++) {
            const max = remaining / (count - i) * 2;
            const a = Math.max(0.01, Math.round(Math.random() * max * 100) / 100);
            amounts.push(a); remaining -= a;
        }
        amounts.push(Math.round(Math.max(0.01, remaining) * 100) / 100);
        const shuffled = [...members].sort(() => Math.random() - 0.5).slice(0, count);
        const results = shuffled.map((name, i) => ({ name, amount: amounts[i] }));
        const best = results.reduce((a, b) => a.amount > b.amount ? a : b);
        msg.opened = true;
        msg.luckyResults = results;
        msg.bestName = best.name;
        S.save();
        const my = results.find(r => r.name === S.get('playerName'));
        if (my) S.set('walletBalance', S.get('walletBalance') + my.amount);
        this.rpDetailMsg = msg;
        this.nav('rp-detail');
    }

    pgRPDetail() {
        const msg = this.rpDetailMsg;
        if (!msg) return this.pgChatList();
        const results = msg.luckyResults || [{ name: msg.sender === S.get('playerName') ? '对方' : S.get('playerName'), amount: msg.amount }];
        const best = msg.bestName || results[0]?.name;

        return `${this.statusBar()}
${this.navbar('红包详情', true)}
<div class="wc-screen"><div class="wc-screen-body" style="background:white;">
    <div class="rp-detail">
        <div class="rpd-sender">${msg.sender}的红包</div>
        <div class="rpd-greeting">${U.esc(msg.greeting)}</div>
        <div class="rpd-total">¥${(msg.totalAmount || msg.amount).toFixed(2)}</div>
    </div>
    <div style="padding:0 16px;font-size:14px;font-weight:600;margin-bottom:8px;">领取记录</div>
    ${results.map(r => `
    <div class="rp-record">
        <div class="rpr-left">
            <img class="rpr-avatar" src="${U.avatar(r.name)}"/>
            <span class="rpr-name">${r.name}</span>
            ${r.name === best ? '<span class="rpr-best">🏆手气最佳</span>' : ''}
        </div>
        <span class="rpr-amount">¥${r.amount.toFixed(2)}</span>
    </div>`).join('')}
</div></div>`;
    }

    // ===== 礼物 =====
    sendGift() {
        const gifts = [
            { emoji: '🌹', name: '玫瑰花', price: 5.20 }, { emoji: '💍', name: '钻戒', price: 520 },
            { emoji: '🧸', name: '泰迪熊', price: 66 }, { emoji: '🎂', name: '生日蛋糕', price: 99 },
            { emoji: '🍫', name: '巧克力', price: 13.14 }, { emoji: '⌚', name: '手表', price: 999 },
            { emoji: '🚗', name: '跑车', price: 8888 }, { emoji: '💐', name: '花束', price: 52 },
            { emoji: '🎮', name: '游戏机', price: 299 }, { emoji: '✈️', name: '机票', price: 1314 },
        ];
        const body = `<div style="max-height:220px;overflow-y:auto;">
            ${gifts.map(g => `<div style="display:flex;align-items:center;padding:8px 0;cursor:pointer;border-bottom:1px solid #f0f0f0;" onclick="W.doGift('${g.emoji}','${g.name}',${g.price})">
                <span style="font-size:24px;margin-right:10px;">${g.emoji}</span><span style="flex:1;font-size:14px;">${g.name}</span><span style="color:#FA5151;font-size:14px;">¥${g.price}</span>
            </div>`).join('')}
        </div>
        <div style="margin-top:8px;border-top:1px solid #eee;padding-top:8px;">
            <input class="wc-input" id="cg-name" placeholder="自定义名称"/>
            <input class="wc-input" id="cg-price" type="number" placeholder="金额"/>
            <input class="wc-input" id="cg-emoji" placeholder="emoji 如🎁" value="🎁"/>
        </div>`;
        this.modal('送礼物', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '自定义发送', action: 'W.doCustomGift()' }
        ]);
    }
    doGift(emoji, name, price) {
        if (price > S.get('walletBalance')) { this.toast('余额不足'); return; }
        S.set('walletBalance', S.get('walletBalance') - price);
        S.addMsg(this.chatId, { type: 'gift', emoji, giftName: name, content: `送出了${name}`, sender: S.get('playerName'), price });
        this.closeModal(); this.pending++; this.render();
    }
    doCustomGift() {
        const n = document.getElementById('cg-name')?.value || '礼物';
        const p = parseFloat(document.getElementById('cg-price')?.value) || 1;
        const e = document.getElementById('cg-emoji')?.value || '🎁';
        this.doGift(e, n, p);
    }

    // ===== 拍一拍 =====
    doPat() {
        if (this.chatIsGroup) {
            const g = S.getGroup(this.chatId);
            if (!g) return;
            const ms = g.members.filter(m => m.name !== S.get('playerName'));
            const body = `<div class="friend-list">${ms.map(m => `
                <div class="friend-row" onclick="W.confirmPat('${U.escAttr(m.name)}')">
                    <img class="fr-avatar" src="${this.getAvatar(m.name, m.avatar)}"/><span class="fr-name">${m.name}</span>
                </div>`).join('')}</div>`;
            this.modal('拍一拍', body, [{ label: '取消', action: 'W.closeModal()' }]);
        } else {
            const f = S.getFriend(this.chatId);
            if (f) this.confirmPat(f.name);
        }
    }
    confirmPat(name) {
        S.addMsg(this.chatId, { type: 'pat', sender: S.get('playerName'), target: name });
        this.closeModal(); this.render();
    }

    // ===== @某人 =====
    atSomeone() {
        const g = S.getGroup(this.chatId);
        if (!g) return;
        const ms = g.members.filter(m => m.name !== S.get('playerName'));
        const body = `<div class="friend-list">${ms.map(m => `
            <div class="friend-row" onclick="W.insertAt('${U.escAttr(m.name)}')">
                <span class="fr-name">${m.name}</span>
            </div>`).join('')}</div>`;
        this.modal('@某人', body, [{ label: '取消', action: 'W.closeModal()' }]);
    }
    insertAt(name) {
        const inp = document.getElementById('chat-inp');
        if (inp) { inp.value += `@${name} `; inp.focus(); this.onInp(inp); }
        this.closeModal();
    }

    // ===== 背包发送 =====
    sendFromBP() {
        const items = S.get('backpack');
        if (!items.length) { this.toast('背包为空'); return; }
        const body = `<div class="friend-list">${items.map(it => `
            <div class="friend-row" onclick="W.doSendBP('${U.escAttr(it.name)}')">
                <span style="font-size:24px;width:36px;text-align:center;">${it.emoji || '📦'}</span>
                <span class="fr-name">${it.name} (×${it.count})</span>
            </div>`).join('')}</div>`;
        this.modal('从背包送出', body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }
    doSendBP(name) {
        const it = S.get('backpack').find(i => i.name === name);
        if (!it) return;
        S.addMsg(this.chatId, { type: 'gift', emoji: it.emoji || '📦', giftName: it.name, content: `从背包送出了${it.name}`, sender: S.get('playerName') });
        S.removeBackpack(name);
        this.closeModal(); this.pending++; this.render();
    }

    // ===== 表情 =====
    toggleEmoji() {
        const emojis = ['😊', '😂', '🤣', '❤️', '😍', '🤔', '😢', '😎', '👍', '🙏', '🎉', '😴', '😭', '😘', '🥰', '😤', '😱', '🤗', '👋', '✨', '🔥', '💪', '🤝', '👏', '😅', '🥺', '😈', '🤤'];
        const body = `<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;">
            ${emojis.map(e => `<span style="font-size:28px;cursor:pointer;padding:2px;" onclick="W.putEmoji('${e}')">${e}</span>`).join('')}
        </div>`;
        this.modal('表情', body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }
    putEmoji(e) {
        const inp = document.getElementById('chat-inp');
        if (inp) { inp.value += e; inp.focus(); this.onInp(inp); }
        this.closeModal();
    }

    viewImg(url) {
        const o = document.createElement('div');
        o.className = 'img-viewer'; o.onclick = () => o.remove();
        o.innerHTML = `<img src="${url}"/>`;
        this.phone?.querySelector('.wc-screen')?.appendChild(o);
    }
    playVid(url) {
        const o = document.createElement('div');
        o.className = 'vid-viewer';
        o.innerHTML = `<video src="${url}" controls autoplay></video><button class="close-v" onclick="this.closest('.vid-viewer').remove()">✕</button>`;
        this.phone?.querySelector('.wc-screen')?.appendChild(o);
    }
    chatMenu(chatId, isG) {
        const body = `<div>
            <div class="friend-row" onclick="W.clearHistory('${chatId}')">🗑️ <span class="fr-name">清空聊天记录</span></div>
            ${isG ? `<div class="friend-row" onclick="W.viewGroupMembers('${chatId}')">👥 <span class="fr-name">群成员</span></div>`
                : `<div class="friend-row" onclick="W.viewContactProfile('${chatId}')">👤 <span class="fr-name">查看资料</span></div>`}
        </div>`;
        this.modal('', body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }
    clearHistory(id) { S._s.chatHistories[id] = []; S.save(); this.closeModal(); this.render(); }
    viewGroupMembers(id) {
        const g = S.getGroup(id); if (!g) return; this.closeModal();
        const body = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px;">
            ${g.members.map(m => `<div style="text-align:center;"><img src="${this.getAvatar(m.name, m.avatar)}" style="width:44px;height:44px;border-radius:6px;object-fit:cover;" onerror="this.src='${U.avatar(m.name)}'"/><div style="font-size:10px;color:#999;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.name}</div></div>`).join('')}
        </div>`;
        this.modal(`群成员(${g.members.length})`, body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }

    // ==================== 页面: 通讯录 ====================
    pgContacts() {
        const friends = [...S.get('friends')].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        return `${this.statusBar()}
${this.navbar('通讯录', false, `<button onclick="W.showAddFriend()">👤+</button>`)}
<div class="wc-screen"><div class="wc-screen-body">
    <div class="wc-search-bar"><input placeholder="搜索"/></div>
    <div class="contact-feature" onclick="W.showAddFriend()">
        <div class="feat-icon" style="background:#FA9D3B;">👤</div><span style="font-size:16px;">新的朋友</span>
    </div>
    <div class="contact-feature" onclick="W.showGroupList()">
        <div class="feat-icon" style="background:#07C160;">👥</div><span style="font-size:16px;">群聊</span>
    </div>
    <div class="contact-section">好友 (${friends.length})</div>
    ${friends.map(f => `
    <div class="contact-item" onclick="W.viewContactProfile('${f.id}')">
        <img class="avatar" src="${this.getAvatar(f.name, f.avatar)}" onerror="this.src='${U.avatar(f.name)}'"/>
        <span class="contact-name">${f.name}</span>
    </div>`).join('')}
    ${friends.length === 0 ? '<div style="text-align:center;padding:30px;color:#999;">暂无好友</div>' : ''}
</div></div>
${this.tabbar('contacts')}`;
    }

    // ===== 添加好友 =====
    showAddFriend() {
        const body = `<div>
            <input class="wc-input" id="af-name" placeholder="好友昵称"/>
            <input class="wc-input" id="af-avatar" placeholder="头像链接 (可选，留空自动生成)"/>
            <textarea class="wc-textarea" id="af-persona" placeholder="人设描述 (可选，留空自动生成)"></textarea>
            <div style="padding:8px;background:#FFF7E6;border-radius:4px;font-size:12px;color:#FA9D3B;margin-top:4px;">
                💡 留空则自动从世界书读取并调用API生成详细信息
            </div>
        </div>`;
        this.modal('添加好友', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '添加', action: 'W.doAddFriend()' }
        ]);
    }

    async doAddFriend() {
        const name = document.getElementById('af-name')?.value?.trim();
        if (!name) { this.toast('请输入昵称'); return; }
        if (S.getFriendByName(name)) { this.toast('已是好友'); return; }

        let avatar = document.getElementById('af-avatar')?.value?.trim() || '';
        let persona = document.getElementById('af-persona')?.value?.trim() || '';
        let chatStyle = '';
        let signature = '';

        this.closeModal();
        this.toast('正在读取世界书并生成信息...');

        const wbData = await WB.getCharData(name);
        if (wbData) {
            if (!avatar && wbData.avatar) avatar = wbData.avatar;
            if (!persona && wbData.persona) persona = wbData.persona;
            if (wbData.chatStyle) chatStyle = wbData.chatStyle;
            if (wbData.signature) signature = wbData.signature;
        }

        if (!avatar || !persona) {
            try {
                const gen = await API.generateFriendInfo(name);
                if (gen) {
                    if (!avatar && gen.avatar) avatar = gen.avatar;
                    if (!persona && gen.persona) persona = gen.persona;
                    if (!chatStyle && gen.chatStyle) chatStyle = gen.chatStyle;
                    if (!signature && gen.signature) signature = gen.signature;
                }
            } catch (e) { console.warn('生成好友信息失败', e); }
        }

        if (!avatar) {
            try {
                const ctx = getContext();
                if (ctx?.characters) {
                    const chars = Array.isArray(ctx.characters) ? ctx.characters : Object.values(ctx.characters);
                    const matched = chars.find(c => c?.name?.toLowerCase() === name.toLowerCase());
                    if (matched?.avatar) avatar = `/characters/${matched.avatar}`;
                }
            } catch (e) { }
        }

        const fid = 'f_' + name.replace(/\s/g, '_') + '_' + Date.now();
        S.addFriend({ id: fid, name, avatar, persona, chatStyle, signature, addedAt: Date.now() });
        this.toast(`已添加"${name}"为好友`);
        this.render();
    }

    showAddMenu() {
        const body = `<div>
            <div class="friend-row" onclick="W.closeModal();W.showAddFriend();">👤 <span class="fr-name">添加好友</span></div>
            <div class="friend-row" onclick="W.closeModal();W.showCreateGroup();">👥 <span class="fr-name">创建群聊</span></div>
            <div class="friend-row" onclick="W.closeModal();W.scanChatNames();">🔍 <span class="fr-name">从聊天记录添加</span></div>
        </div>`;
        this.modal('', body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }

    async scanChatNames() {
        const existing = new Set(S.get('friends').map(f => f.name));
        existing.add(S.get('playerName'));
        const mentioned = new Set();
        Object.values(S._s.chatHistories).forEach(h => {
            h.forEach(m => {
                if (m.sender && !existing.has(m.sender) && m.sender !== '系统') mentioned.add(m.sender);
                if (m.content) {
                    const ats = m.content.match(/@(\S+)/g);
                    if (ats) ats.forEach(a => { const n = a.substring(1); if (!existing.has(n)) mentioned.add(n); });
                }
            });
        });
        if (!mentioned.size) { this.toast('未找到新人名'); return; }
        const names = Array.from(mentioned);
        const body = `<div style="font-size:13px;color:#888;margin-bottom:8px;">聊天记录中发现：</div>
            <div class="friend-list">${names.map(n => `
                <div class="friend-row" onclick="W.tryAutoAdd('${U.escAttr(n)}')">
                    <img class="fr-avatar" src="${U.avatar(n)}"/><span class="fr-name">${n}</span>
                    <span style="font-size:12px;color:#07C160;margin-left:auto;">点击添加</span>
                </div>`).join('')}</div>`;
        this.modal('从聊天记录添加', body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }

    async tryAutoAdd(name) {
        this.toast(`正在查找"${name}"...`);
        let avatar = '';
        let persona = '';
        const wbData = await WB.getCharData(name);
        if (wbData) { avatar = wbData.avatar || ''; persona = wbData.persona || ''; }
        if (!avatar || !persona) {
            try {
                const gen = await API.generateFriendInfo(name);
                if (gen) { avatar = gen.avatar || ''; persona = gen.persona || ''; }
            } catch (e) { }
        }
        const fid = 'f_' + name.replace(/\s/g, '_') + '_' + Date.now();
        S.addFriend({ id: fid, name, avatar, persona, signature: '', addedAt: Date.now() });
        this.toast(`已添加"${name}"`);
        this.closeModal();
        this.render();
    }

    // ===== 群聊 =====
    showGroupList() {
        const groups = S.get('groups');
        const body = `<div>
            ${groups.map(g => `<div class="friend-row" onclick="W.closeModal();W.openChat('${g.id}',true);">
                <img class="fr-avatar" src="${this.getAvatar(g.name, g.avatar)}"/><span class="fr-name">${g.name} (${g.members?.length || 0}人)</span>
            </div>`).join('')}
            ${groups.length === 0 ? '<div style="text-align:center;padding:20px;color:#999;">暂无群聊</div>' : ''}
            <div style="margin-top:12px;border-top:1px solid #eee;padding-top:12px;">
                <button class="sp-btn green" onclick="W.closeModal();W.showCreateGroup();">创建群聊</button>
            </div>
        </div>`;
        this.modal('群聊', body, [{ label: '关闭', action: 'W.closeModal()' }]);
    }

    showCreateGroup() {
        const friends = S.get('friends');
        const body = `<div>
            <input class="wc-input" id="grp-name" placeholder="群聊名称"/>
            <div style="font-size:13px;color:#888;margin-bottom:8px;">选择群成员：</div>
            <div class="friend-list" style="max-height:200px;">
                ${friends.map(f => `<label class="friend-row" style="cursor:pointer;">
                    <input type="checkbox" class="grp-chk" value="${f.id}" data-name="${f.name}" data-avatar="${f.avatar || ''}" style="margin-right:8px;"/>
                    <img class="fr-avatar" src="${this.getAvatar(f.name, f.avatar)}"/><span class="fr-name">${f.name}</span>
                </label>`).join('')}
            </div>
        </div>`;
        this.modal('创建群聊', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '创建', action: 'W.doCreateGroup()' }
        ]);
    }
    doCreateGroup() {
        const name = document.getElementById('grp-name')?.value?.trim();
        if (!name) { this.toast('请输入群名'); return; }
        const cbs = document.querySelectorAll('.grp-chk:checked');
        const members = [{ id: S.get('playerId'), name: S.get('playerName'), avatar: S.get('playerAvatar') }];
        cbs.forEach(cb => { const f = S.getFriend(cb.value); if (f) members.push({ id: f.id, name: f.name, avatar: f.avatar }); });
        if (members.length < 2) { this.toast('至少选1个好友'); return; }
        const gid = 'g_' + Date.now();
        S._s.groups.push({ id: gid, name, avatar: '', members, createdAt: Date.now() }); S.save();
        S.addMsg(gid, { type: 'system', content: `${S.get('playerName')}创建了群聊"${name}"`, sender: '系统' });
        this.closeModal(); this.openChat(gid, true);
    }

    openChat(id, isGroup = false) {
        this.chatId = id; this.chatIsGroup = isGroup; this.nav('chat');
    }

    // ===== 联系人资料 =====
    viewContactProfile(id) { this.contactId = id; this.nav('profile'); }
    viewProfile(name) {
        if (name === S.get('playerName')) { this.nav('persona'); return; }
        const f = S.getFriendByName(name);
        if (f) this.viewContactProfile(f.id);
    }

    pgProfile() {
        const f = S.getFriend(this.contactId);
        if (!f) return this.pgContacts();
        return `${this.statusBar()}
${this.navbar('详细资料', true)}
<div class="wc-screen"><div class="wc-screen-body" style="background:var(--wc-bg);">
    <div class="profile-card"><div class="pf-row">
        <img class="pf-avatar" src="${this.getAvatar(f.name, f.avatar)}" onerror="this.src='${U.avatar(f.name)}'" onclick="W.changeFriendAvatar('${f.id}')"/>
        <div><h3>${f.name}</h3><p>微信号: ${f.id}</p>${f.signature ? `<p>${f.signature}</p>` : ''}</div>
    </div></div>
    <button class="pf-btn green" onclick="W.openChat('${f.id}',false)">发消息</button>
    <button class="pf-btn blue" onclick="W.editFriend('${f.id}')">修改信息</button>
    <button class="pf-btn red" onclick="W.deleteFriend('${f.id}')">删除好友</button>
</div></div>`;
    }

    changeFriendAvatar(id) {
        const body = `<div>
            <input class="wc-input" id="cfa-url" placeholder="头像链接"/>
            <input type="file" accept="image/*" id="cfa-file" style="font-size:13px;"/>
        </div>`;
        this.modal('修改头像', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '确定', action: `W.doChangeFriendAvatar('${id}')` }
        ]);
    }
    async doChangeFriendAvatar(id) {
        const f = S.getFriend(id); if (!f) return;
        const url = document.getElementById('cfa-url')?.value?.trim();
        const fi = document.getElementById('cfa-file');
        if (url) { f.avatar = url; } else if (fi?.files?.length) { f.avatar = await U.readFile(fi.files[0]); }
        S.save(); this.closeModal(); this.render();
    }

    editFriend(id) {
        const f = S.getFriend(id); if (!f) return;
        const body = `<div>
            <label style="font-size:14px">昵称</label><input class="wc-input" id="ef-name" value="${f.name}"/>
            <label style="font-size:14px">头像链接</label><input class="wc-input" id="ef-avatar" value="${f.avatar || ''}" placeholder="链接或留空"/>
            <label style="font-size:14px">上传头像</label><input type="file" accept="image/*" id="ef-file" style="font-size:13px;margin-bottom:10px;"/>
            <label style="font-size:14px">人设</label><textarea class="wc-textarea" id="ef-persona">${f.persona || ''}</textarea>
            <label style="font-size:14px">签名</label><input class="wc-input" id="ef-sig" value="${f.signature || ''}"/>
        </div>`;
        this.modal('修改信息', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '保存', action: `W.doEditFriend('${id}')` }
        ]);
    }
    async doEditFriend(id) {
        const f = S.getFriend(id); if (!f) return;
        const name = document.getElementById('ef-name')?.value?.trim();
        const avatar = document.getElementById('ef-avatar')?.value?.trim();
        const persona = document.getElementById('ef-persona')?.value?.trim();
        const sig = document.getElementById('ef-sig')?.value?.trim();
        const fi = document.getElementById('ef-file');
        if (name) f.name = name;
        if (avatar) f.avatar = avatar;
        if (persona !== undefined) f.persona = persona;
        if (sig !== undefined) f.signature = sig;
        if (fi?.files?.length) f.avatar = await U.readFile(fi.files[0]);
        S.save(); this.closeModal(); this.render(); this.toast('已保存');
    }

    deleteFriend(id) {
        const f = S.getFriend(id); if (!f) return;
        this.modal('删除好友', `<div style="text-align:center">确定删除"${f.name}"？</div>`, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '删除', action: `W.doDeleteFriend('${id}')` }
        ]);
    }
    doDeleteFriend(id) {
        const f = S.getFriend(id);
        S.removeFriend(id);
        this.closeModal(); this.toast(`已删除"${f?.name || ''}"`); this.switchTab('contacts');
    }

    // ==================== 页面: 发现 ====================
    pgDiscover() {
        return `${this.statusBar()}
${this.navbar('发现')}
<div class="wc-screen"><div class="wc-screen-body" style="background:var(--wc-bg);">
    <div class="discover-group">
        <div class="discover-item" onclick="W.nav('moments')"><div class="d-icon">🌅</div><div class="d-text">朋友圈</div><span class="d-arrow">›</span></div>
    </div>
    <div class="discover-group">
        <div class="discover-item" onclick="W.nav('oa-list')"><div class="d-icon">📰</div><div class="d-text">公众号</div><span class="d-arrow">›</span></div>
    </div>
    <div class="discover-group">
        <div class="discover-item" onclick="W.openShop()"><div class="d-icon">🛒</div><div class="d-text">购物</div><span class="d-arrow">›</span></div>
    </div>
    <div class="discover-group">
        <div class="discover-item" onclick="W.openForum()"><div class="d-icon">💬</div><div class="d-text">论坛</div><span class="d-arrow">›</span></div>
    </div>
</div></div>
${this.tabbar('discover')}`;
    }

    // ==================== 页面: 我 ====================
    pgMe() {
        const av = S.get('playerAvatar') || U.avatar(S.get('playerName'));
        return `${this.statusBar()}
${this.navbar('我')}
<div class="wc-screen"><div class="wc-screen-body" style="background:var(--wc-bg);">
    <div class="me-card" onclick="W.nav('persona')">
        <img class="me-avatar" src="${av}" onerror="this.src='${U.avatar(S.get('playerName'))}'" onclick="event.stopPropagation();W.changeMyAvatar();"/>
        <div><div class="me-name">${S.get('playerName')}</div><div class="me-id">微信号: ${S.get('playerId')}</div></div>
    </div>
    <div class="me-group">
        <div class="me-item" onclick="W.nav('wallet')"><div class="m-icon">💰</div><div class="m-text">钱包</div><span class="m-extra">¥${S.get('walletBalance').toFixed(2)}</span><span class="m-arrow">›</span></div>
    </div>
    <div class="me-group">
        <div class="me-item" onclick="W.nav('backpack')"><div class="m-icon">🎒</div><div class="m-text">背包</div><span class="m-extra">${S.get('backpack').length}件</span><span class="m-arrow">›</span></div>
    </div>
    <div class="me-group">
        <div class="me-item" onclick="W.nav('persona')"><div class="m-icon">✏️</div><div class="m-text">个人人设</div><span class="m-arrow">›</span></div>
        <div class="me-item" onclick="W.openSettings()"><div class="m-icon">⚙️</div><div class="m-text">插件设置</div><span class="m-arrow">›</span></div>
    </div>
</div></div>
${this.tabbar('me')}`;
    }

    changeMyAvatar() {
        const body = `<div>
            <input class="wc-input" id="ma-url" value="${S.get('playerAvatar')}" placeholder="头像链接"/>
            <input type="file" accept="image/*" id="ma-file" style="font-size:13px;"/>
        </div>`;
        this.modal('修改头像', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '确定', action: 'W.doChangeMyAvatar()' }
        ]);
    }
    async doChangeMyAvatar() {
        const url = document.getElementById('ma-url')?.value?.trim();
        const fi = document.getElementById('ma-file');
        if (url) S.set('playerAvatar', url);
        else if (fi?.files?.length) S.set('playerAvatar', await U.readFile(fi.files[0]));
        this.closeModal(); this.render();
    }

    // ==================== 页面: 人设 ====================
    pgPersona() {
        return `${this.statusBar()}
${this.navbar('个人人设', true, '<button onclick="W.savePersona()" style="background:#07C160;color:white;border:none;border-radius:4px;padding:4px 12px;font-size:14px;cursor:pointer;">保存</button>')}
<div class="wc-screen"><div class="wc-screen-body" style="padding:16px;background:white;">
    <div class="sp-row"><label>昵称</label><input id="ps-name" value="${S.get('playerName')}"/></div>
    <div class="sp-row"><label>头像链接</label><input id="ps-avatar" value="${S.get('playerAvatar')}" placeholder="链接"/></div>
    <div class="sp-row"><label>上传头像</label><input type="file" accept="image/*" onchange="W.uploadMyAvatar(this)" style="font-size:14px;"/></div>
    <div class="sp-row"><label>微信号</label><input id="ps-wxid" value="${S.get('playerId')}"/></div>
    <div class="sp-row"><label>个性签名</label><input id="ps-sig" value="${S.get('playerSignature')}"/></div>
    <div class="sp-row"><label>人设描述(AI参考)</label><textarea id="ps-persona" style="min-height:120px;">${S.get('playerPersona')}</textarea></div>
</div></div>`;
    }
    uploadMyAvatar(inp) {
        if (inp?.files?.length) {
            const r = new FileReader();
            r.onload = e => { document.getElementById('ps-avatar').value = e.target.result; };
            r.readAsDataURL(inp.files[0]);
        }
    }
    savePersona() {
        S.set('playerName', document.getElementById('ps-name')?.value?.trim() || '我');
        S.set('playerAvatar', document.getElementById('ps-avatar')?.value?.trim() || '');
        S.set('playerId', document.getElementById('ps-wxid')?.value?.trim() || 'wxid_player');
        S.set('playerSignature', document.getElementById('ps-sig')?.value?.trim() || '');
        S.set('playerPersona', document.getElementById('ps-persona')?.value?.trim() || '');
        this.toast('已保存'); this.goBack();
    }

    // ==================== 页面: 朋友圈 ====================
    pgMoments() {
        const moments = [...S.get('moments')].reverse();
        const av = S.get('playerAvatar') || U.avatar(S.get('playerName'));
        const bg = S.get('momentBg') || `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e"/><stop offset="100%" style="stop-color:#16213e"/></linearGradient></defs><rect fill="url(#g)" width="400" height="260"/></svg>')}`;

        return `${this.statusBar()}
${this.navbar('朋友圈', true, `<button onclick="W.nav('compose-moment')">${IC.camera}</button>`)}
<div class="wc-screen"><div class="wc-screen-body" style="background:white;">
    <div class="moments-header">
        <img class="m-cover" src="${bg}"/>
        <div class="m-profile">
            <span class="m-profile-name">${S.get('playerName')}</span>
            <img class="m-profile-avatar" src="${av}" onerror="this.src='${U.avatar(S.get('playerName'))}'"/>
        </div>
    </div>
    ${moments.map(m => this.renderMoment(m)).join('')}
    ${moments.length === 0 ? '<div style="text-align:center;padding:40px;color:#999;">朋友圈空空如也~</div>' : ''}
</div></div>`;
    }
    renderMoment(m) {
        const av = m.avatar || U.avatar(m.author);
        const imgs = m.images?.length ? `<div class="moment-images g${Math.min(m.images.length, 3)}">
            ${m.images.map(i => `<img src="${i}" onerror="this.style.display='none'" onclick="W.viewImg('${U.escAttr(i)}')" />`).join('')}
        </div>` : '';
        const inter = (m.likes?.length || m.comments?.length) ? `<div class="moment-interactions">
            ${m.likes?.length ? `<div class="moment-likes">❤️ ${m.likes.map(n => `<span class="like-name">${n}</span>`).join('，')}</div>` : ''}
            ${m.comments?.length ? `<div class="moment-comments">${m.comments.map(c => `
                <div class="moment-comment"><span class="commenter">${c.sender}</span>${c.replyTo ? ` 回复 <span class="commenter">${c.replyTo}</span>` : ''}：${U.esc(c.content)}${c.image ? ` <img src="${c.image}" style="max-width:60px;max-height:60px;border-radius:4px;cursor:pointer;" onclick="W.viewImg('${U.escAttr(c.image)}')" />` : ''}
                </div>`).join('')}</div>` : ''}
        </div>` : '';
        return `<div class="moment-item">
            <img class="moment-avatar" src="${av}" onerror="this.src='${U.avatar(m.author)}'"/>
            <div class="moment-body">
                <div class="moment-name">${m.author}</div>
                <div class="moment-text">${U.esc(m.text)}</div>
                ${imgs}
                <div class="moment-time-row"><span class="moment-time">${U.fmtTime(m.timestamp)}</span></div>
                ${inter}
            </div>
        </div>`;
    }

    pgComposeMoment() {
        return `${this.statusBar()}
${this.navbar('发表', true, '<button onclick="W.publishMoment()" style="background:#07C160;color:white;border:none;border-radius:4px;padding:4px 12px;font-size:14px;cursor:pointer;">发表</button>')}
<div class="wc-screen"><div class="wc-screen-body" style="background:white;padding:16px;">
    <textarea id="mt-text" placeholder="这一刻的想法..." style="width:100%;min-height:120px;border:none;outline:none;font-size:16px;resize:none;box-sizing:border-box;font-family:inherit;"></textarea>
    <div id="mt-imgs" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
        ${this.momentImgs.map(i => `<img src="${i}" style="width:80px;height:80px;object-fit:cover;border-radius:4px;"/>`).join('')}
        <div onclick="W.addMomentImg()" style="width:80px;height:80px;border:1px dashed #ccc;border-radius:4px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:28px;color:#ccc;">+</div>
    </div>
    <input class="wc-input" id="mt-imgurl" placeholder="图片链接(可选)" style="margin-top:10px;"/>
</div></div>`;
    }
    addMomentImg() {
        const url = document.getElementById('mt-imgurl')?.value?.trim();
        if (url) { this.momentImgs.push(url); document.getElementById('mt-imgurl').value = ''; this.render(); return; }
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
        inp.onchange = e => {
            Array.from(e.target.files).forEach(f => {
                const r = new FileReader();
                r.onload = ev => { this.momentImgs.push(ev.target.result); this.render(); };
                r.readAsDataURL(f);
            });
        };
        inp.click();
    }
    async publishMoment() {
        const text = document.getElementById('mt-text')?.value?.trim();
        if (!text) { this.toast('请输入内容'); return; }
        const moment = { id: 'm_' + Date.now(), author: S.get('playerName'), avatar: S.get('playerAvatar'), text, images: [...this.momentImgs], timestamp: Date.now(), likes: [], comments: [] };
        S._s.moments.push(moment); S.save();
        this.momentImgs = [];
        this.toast('已发布'); this.goBack();
        try {
            const reactions = await API.momentComments(text);
            const m = S._s.moments.find(x => x.id === moment.id);
            if (m) { m.likes = reactions.likes || []; m.comments = reactions.comments || []; S.save(); if (this.page === 'moments') this.render(); }
        } catch (e) { }
    }

    // ==================== 页面: 钱包 ====================
    pgWallet() {
        return `${this.statusBar()}
${this.navbar('钱包', true)}
<div class="wc-screen"><div class="wc-screen-body" style="background:var(--wc-bg);">
    <div class="wallet-card"><div class="bal-label">余额</div><div class="bal-amount">¥${S.get('walletBalance').toFixed(2)}</div></div>
    <div class="wallet-actions">
        <div class="wallet-action" onclick="W.walletRecharge()"><div class="wa-icon">💰</div><span>充值</span></div>
        <div class="wallet-action" onclick="W.walletTransfer()"><div class="wa-icon">💸</div><span>转账</span></div>
    </div>
</div></div>`;
    }
    walletRecharge() {
        this.modal('充值', '<input class="wc-input" id="rc-amt" type="number" value="100" placeholder="金额"/>', [
            { label: '取消', action: 'W.closeModal()' },
            { label: '充值', action: 'W.doRecharge()' }
        ]);
    }
    doRecharge() {
        const amt = parseFloat(document.getElementById('rc-amt')?.value) || 0;
        if (amt <= 0) { this.toast('金额无效'); return; }
        S.set('walletBalance', S.get('walletBalance') + amt);
        this.closeModal(); this.render(); this.toast(`+¥${amt.toFixed(2)}`);
    }
    walletTransfer() {
        const friends = S.get('friends');
        this.modal('转账', `<select class="wc-select" id="tf-target">${friends.map(f => `<option value="${f.id}">${f.name}</option>`).join('')}</select><input class="wc-input" id="tf-amt" type="number" placeholder="金额"/>`, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '转账', action: 'W.doTransfer()' }
        ]);
    }
    doTransfer() {
        const tid = document.getElementById('tf-target')?.value;
        const amt = parseFloat(document.getElementById('tf-amt')?.value) || 0;
        if (amt <= 0 || amt > S.get('walletBalance')) { this.toast(amt <= 0 ? '金额无效' : '余额不足'); return; }
        const f = S.getFriend(tid);
        S.set('walletBalance', S.get('walletBalance') - amt);
        if (f) S.addMsg(tid, { type: 'system', content: `你向${f.name}转账了¥${amt.toFixed(2)}`, sender: '系统' });
        this.closeModal(); this.render(); this.toast(`已转账¥${amt.toFixed(2)}`);
    }

    // ==================== 页面: 背包 ====================
    pgBackpack() {
        const items = S.get('backpack');
        return `${this.statusBar()}
${this.navbar('背包', true)}
<div class="wc-screen"><div class="wc-screen-body" style="background:var(--wc-bg);padding:12px;">
    ${items.length ? `<div class="bp-grid">${items.map(it => `
        <div class="bp-item" onclick="W.useBPItem('${U.escAttr(it.name)}')">
            <div class="bp-icon">${it.emoji || '📦'}</div><div class="bp-name">${it.name}</div>
            ${it.count > 1 ? `<span class="bp-count">×${it.count}</span>` : ''}
        </div>`).join('')}</div>`
            : '<div style="text-align:center;padding:60px;color:#999;">背包空空~<br>去购物吧</div>'}
</div></div>`;
    }
    useBPItem(name) {
        const it = S.get('backpack').find(i => i.name === name);
        if (!it) return;
        const friends = S.get('friends');
        const body = `<div style="text-align:center;margin-bottom:12px;">
            <span style="font-size:48px;">${it.emoji || '📦'}</span>
            <div style="font-size:16px;font-weight:600;">${it.name} ×${it.count}</div>
        </div>
        <div style="font-size:14px;color:#666;margin-bottom:8px;">送给好友：</div>
        <div class="friend-list" style="max-height:200px;">
            ${friends.map(f => `<div class="friend-row" onclick="W.giftToBP('${f.id}','${U.escAttr(name)}')">
                <img class="fr-avatar" src="${this.getAvatar(f.name, f.avatar)}"/><span class="fr-name">${f.name}</span>
            </div>`).join('')}
        </div>`;
        this.modal('使用物品', body, [
            { label: '丢弃', action: `W.discardBP('${U.escAttr(name)}')` },
            { label: '关闭', action: 'W.closeModal()' }
        ]);
    }
    giftToBP(fid, name) {
        const it = S.get('backpack').find(i => i.name === name);
        const f = S.getFriend(fid);
        if (!it || !f) return;
        S.addMsg(fid, { type: 'gift', emoji: it.emoji || '📦', giftName: it.name, content: `从背包送出了${it.name}`, sender: S.get('playerName') });
        S.removeBackpack(name);
        this.closeModal(); this.pending++; this.toast(`已送给${f.name}`); this.render();
    }
    discardBP(name) { S.removeBackpack(name); this.closeModal(); this.render(); this.toast('已丢弃'); }

    // ==================== 页面: 公众号 ====================
    pgOAList() {
        const followed = S.get('followedOA');
        return `${this.statusBar()}
${this.navbar('公众号', true)}
<div class="wc-screen"><div class="wc-screen-body" style="background:var(--wc-bg);">
    <div class="wc-search-bar" style="display:flex;gap:8px;">
        <input id="oa-q" placeholder="搜索公众号" style="flex:1;"/>
    </div>
    <button onclick="W.searchOA()" style="display:block;margin:0 12px 12px;background:#07C160;color:white;border:none;border-radius:6px;padding:8px;width:calc(100% - 24px);cursor:pointer;font-size:14px;box-sizing:border-box;">搜索</button>
    ${followed.length ? '<div style="padding:8px 16px;font-size:13px;color:#999;">已关注</div>' : ''}
    ${followed.map(oa => `<div class="oa-item" onclick="W.openOA('${U.escAttr(oa.name)}')">
        <div class="oa-avatar">${oa.avatar || '📰'}</div>
        <div><div class="oa-name">${oa.name}</div><div class="oa-desc">${oa.desc || ''}</div></div>
    </div>`).join('')}
    <div id="oa-results"></div>
</div></div>`;
    }
    async searchOA() {
        const q = document.getElementById('oa-q')?.value?.trim();
        if (!q) { this.toast('请输入搜索内容'); return; }
        this.toast('搜索中...');
        const accounts = await API.searchOA(q);
        const div = document.getElementById('oa-results');
        if (div) {
            div.innerHTML = accounts.map(oa => {
                const isFollowed = S.get('followedOA').find(f => f.name === oa.name);
                return `<div class="oa-item">
                    <div class="oa-avatar">${oa.avatar || '📰'}</div>
                    <div style="flex:1;"><div class="oa-name">${oa.name}</div><div class="oa-desc">${oa.desc || ''}</div></div>
                    <button class="oa-follow ${isFollowed ? 'followed' : ''}" onclick="W.followOA('${U.escAttr(oa.name)}','${U.escAttr(oa.desc || '')}','${U.escAttr(oa.avatar || '📰')}');event.stopPropagation();">
                        ${isFollowed ? '已关注' : '+ 关注'}
                    </button>
                </div>`;
            }).join('');
        }
    }
    followOA(name, desc, avatar) {
        const followed = S.get('followedOA');
        if (followed.find(f => f.name === name)) { this.toast('已关注'); return; }
        followed.push({ name, desc, avatar });
        S.set('followedOA', followed);
        this.toast(`已关注"${name}"`);
        this.render();
    }
    openOA(name) {
        this.oaName = name; this.oaArticles = [];
        this.nav('oa-detail');
    }

    pgOADetail() {
        return `${this.statusBar()}
${this.navbar(this.oaName, true, '<button onclick="W.pushArticles()" style="background:#07C160;color:white;border:none;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;">推送</button>')}
<div class="wc-screen"><div class="wc-screen-body" style="background:var(--wc-bg);">
    ${this.oaArticles.map(a => `<div class="article-card" onclick='W.readArticle(${JSON.stringify(a).replace(/'/g, "&#39;")})'>
        <div class="a-title">${U.esc(a.title)}</div><div class="a-desc">${U.esc(a.summary || '')}</div>
    </div>`).join('')}
    ${this.oaArticles.length === 0 ? '<div style="text-align:center;padding:40px;color:#999;">点击推送按钮获取文章</div>' : ''}
</div></div>`;
    }
    async pushArticles() {
        this.toast('获取中...'); this.oaArticles = await API.genArticles(this.oaName); this.render();
    }
    readArticle(a) { this.currentArticle = a; this.nav('article'); }
    pgArticle() {
        const a = this.currentArticle;
        if (!a) return this.pgOADetail();
        return `${this.statusBar()}
${this.navbar('文章', true)}
<div class="wc-screen"><div class="wc-screen-body">
    <div class="article-reader">
        <div class="ar-title">${U.esc(a.title)}</div>
        <div class="ar-meta">阅读 ${a.readCount || Math.floor(Math.random() * 10000)}</div>
        <div class="ar-body">${a.content ? a.content.split('\n').map(p => `<p>${U.esc(p)}</p>`).join('') : ''}</div>
    </div>
</div></div>`;
    }

    // ==================== 页面: 购物 ====================
    async openShop() {
        this.nav('shop');
        if (!this.shopItems.length) {
            this.shopItems = await API.genShopItems();
            this.render();
        }
    }
    pgShop() {
        const cart = S.get('shoppingCart');
        const cartN = cart.reduce((s, c) => s + c.qty, 0);
        const cartT = cart.reduce((s, c) => s + c.price * c.qty, 0);
        return `${this.statusBar()}
${this.navbar('购物', true)}
<div class="wc-screen" style="display:flex;flex-direction:column;">
    <div style="flex:1;overflow-y:auto;">
        <div class="shop-header">
            <input class="shop-search" id="shop-q" placeholder="搜索商品"/>
            <button class="shop-search-btn" onclick="W.searchShop()">搜索</button>
        </div>
        <div class="shop-grid" id="shop-grid">
            ${this.shopItems.map(it => `<div class="shop-item" onclick="W.addCart('${U.escAttr(it.name)}',${it.price},'${it.emoji || '📦'}')">
                <div class="si-img">${it.emoji || '📦'}</div>
                <div class="si-info"><div class="si-name">${U.esc(it.name)}</div><div class="si-price"><span class="unit">¥</span>${it.price}</div></div>
            </div>`).join('')}
            ${this.shopItems.length === 0 ? `<div style="grid-column:span 2;text-align:center;padding:40px;">${this.loading()}<div style="color:#999;margin-top:10px;">加载中...</div></div>` : ''}
        </div>
    </div>
    <div class="cart-bar">
        <div class="cb-icon" onclick="W.toggleCart()">🛒${cartN > 0 ? `<span class="cb-badge">${cartN}</span>` : ''}</div>
        <div class="cb-total"><span class="unit">¥</span>${cartT.toFixed(2)}</div>
        <button class="cb-checkout" onclick="W.checkout()">结算(${cartN})</button>
    </div>
    <div class="cart-panel" id="cart-panel" style="display:none;">
        <div class="cart-panel-hd"><span>购物车</span><button class="clear-btn" onclick="W.clearCart()">清空</button></div>
        ${cart.map(c => `<div class="cart-row">
            <span class="cr-name">${c.emoji || ''} ${c.name}</span><span class="cr-price">¥${c.price}</span>
            <div class="cr-qty"><button onclick="W.cartQty('${U.escAttr(c.name)}',-1)">-</button><span>${c.qty}</span><button onclick="W.cartQty('${U.escAttr(c.name)}',1)">+</button></div>
        </div>`).join('')}
        ${cart.length === 0 ? '<div style="text-align:center;padding:20px;color:#999;">购物车空</div>' : ''}
    </div>
</div>`;
    }
    async searchShop() {
        const q = document.getElementById('shop-q')?.value?.trim();
        if (!q) return;
        this.toast('搜索中...');
        this.shopItems = await API.genShopItems(q);
        this.render();
    }
    addCart(name, price, emoji) {
        const cart = S.get('shoppingCart');
        const ex = cart.find(c => c.name === name);
        if (ex) ex.qty++; else cart.push({ name, price, emoji, qty: 1 });
        S.save(); this.render(); this.toast(`已加入: ${name}`);
    }
    cartQty(name, d) {
        const cart = S.get('shoppingCart');
        const it = cart.find(c => c.name === name);
        if (!it) return;
        it.qty += d;
        if (it.qty <= 0) S.set('shoppingCart', cart.filter(c => c.name !== name));
        else S.save();
        this.render();
    }
    clearCart() { S.set('shoppingCart', []); this.render(); }
    toggleCart() { const p = document.getElementById('cart-panel'); if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
    checkout() {
        const cart = S.get('shoppingCart');
        if (!cart.length) { this.toast('购物车空'); return; }
        const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
        if (total > S.get('walletBalance')) { this.toast('余额不足'); return; }
        const body = `<div>${cart.map(c => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;"><span>${c.emoji} ${c.name} ×${c.qty}</span><span style="color:#FA5151;">¥${(c.price * c.qty).toFixed(2)}</span></div>`).join('')}
        <div style="border-top:1px solid #eee;margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;font-weight:600;"><span>合计</span><span style="color:#FA5151;font-size:18px;">¥${total.toFixed(2)}</span></div>
        <div style="margin-top:8px;font-size:13px;color:#888;">购买后放入背包</div></div>`;
        this.modal('确认结算', body, [
            { label: '取消', action: 'W.closeModal()' },
            { label: '支付', action: 'W.doCheckout()' }
        ]);
    }
    doCheckout() {
        const cart = S.get('shoppingCart');
        const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
        S.set('walletBalance', S.get('walletBalance') - total);
        cart.forEach(c => S.addBackpack({ name: c.name, emoji: c.emoji, price: c.price, count: c.qty }));
        S.set('shoppingCart', []);
        this.closeModal(); this.toast('购买成功！'); this.render();
    }

    // ==================== 页面: 论坛 ====================
    async openForum() {
        this.nav('forum');
        if (!this.forumPosts.length) {
            this.forumPosts = await API.genForumPosts();
            this.render();
        }
    }
    pgForum() {
        return `${this.statusBar()}
${this.navbar('论坛', true, '<button onclick="W.refreshForum()" style="background:#07C160;color:white;border:none;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;">刷新</button>')}
<div class="wc-screen"><div class="wc-screen-body" style="background:var(--wc-bg);">
    <div style="padding:8px 12px;display:flex;gap:8px;">
        <input class="wc-input" id="forum-q" placeholder="搜索帖子" style="flex:1;margin:0;"/>
        <button onclick="W.searchForum()" style="background:#07C160;color:white;border:none;border-radius:6px;padding:0 12px;cursor:pointer;">搜索</button>
    </div>
    ${this.forumPosts.map((p, i) => `
    <div class="forum-post" onclick="W.openForumPost(${i})">
        <div class="fp-header"><img class="fp-avatar" src="${U.avatar(p.author)}"/><div><div class="fp-author">${p.author}</div><div class="fp-time">${p.time || '刚刚'}</div></div></div>
        <div class="fp-title">${U.esc(p.title)}</div>
        <div class="fp-content">${U.esc(p.content).substring(0, 100)}...</div>
        <div class="fp-stats"><span class="fp-stat">👍 ${p.likes || 0}</span><span class="fp-stat">💬 ${p.replies?.length || 0}</span></div>
    </div>`).join('')}
    ${this.forumPosts.length === 0 ? `<div style="text-align:center;padding:40px;">${this.loading()}<div style="color:#999;">加载中...</div></div>` : ''}
</div></div>`;
    }
    async refreshForum() {
        this.toast('刷新中...'); this.forumPosts = await API.genForumPosts(); this.render();
    }
    async searchForum() {
        const q = document.getElementById('forum-q')?.value?.trim();
        if (!q) return;
        this.toast('搜索中...');
        this.forumPosts = await API.genForumPosts(q);
        this.render();
    }
    openForumPost(idx) {
        this.currentForumPost = this.forumPosts[idx];
        this.nav('forum-detail');
    }
    pgForumDetail() {
        const p = this.currentForumPost;
        if (!p) return this.pgForum();
        return `${this.statusBar()}
${this.navbar('帖子', true)}
<div class="wc-screen"><div class="wc-screen-body" style="background:white;">
    <div class="forum-detail">
        <div class="fd-title">${U.esc(p.title)}</div>
        <div class="fd-meta">${p.author} · ${p.time || '刚刚'} · 👍${p.likes || 0}</div>
        <div class="fd-body">${U.esc(p.content)}</div>
    </div>
    <div style="padding:8px 16px;font-size:14px;font-weight:600;background:var(--wc-bg);">回复 (${p.replies?.length || 0})</div>
    ${(p.replies || []).map(r => `
    <div class="forum-reply">
        <div class="fr-header">
            <img class="fr-avatar" src="${U.avatar(r.author)}"/>
            <span class="fr-name">${r.author}</span>
            <span class="fr-time">${r.time || '刚刚'}</span>
        </div>
        <div class="fr-content">${U.esc(r.content)}</div>
    </div>`).join('')}
    ${(p.replies || []).length === 0 ? '<div style="text-align:center;padding:20px;color:#999;">暂无回复</div>' : ''}
</div></div>`;
    }

    // ==================== 设置面板 ====================
    openSettings() {
        const panel = document.getElementById('wc-settings-panel');
        if (!panel) return;
        const models = S.get('availableModels');
        panel.innerHTML = `
<div class="sp-hd">
    <span>⚙️ WeChatSim 设置</span>
    <button class="sp-close" ontouchend="W.closeSettings();event.preventDefault();" onclick="W.closeSettings()" style="font-size:28px;padding:4px 8px;">✕</button>
</div>
<div class="sp-bd">
    <div class="sp-group">
        <h4>API 配置</h4>
        <div class="sp-row"><label>API 地址</label><input id="st-endpoint" value="${S.get('apiEndpoint')}" placeholder="https://api.openai.com/v1"/></div>
        <div class="sp-row"><label>API Key</label><input id="st-key" type="password" value="${S.get('apiKey')}" placeholder="sk-..."/></div>
        <div class="sp-row"><button class="sp-btn green" ontouchend="W.fetchModels();event.preventDefault();" onclick="W.fetchModels()">拉取模型列表</button></div>
        <div class="sp-row"><label>选择模型</label>
            <select id="st-model-select">
                <option value="">-- 请选择 --</option>
                ${models.map(m => `<option value="${m.id}" ${m.id === S.get('modelId') ? 'selected' : ''}>${m.name}</option>`).join('')}
            </select>
        </div>
        <div class="sp-row"><label>自定义模型ID</label><input id="st-model-custom" value="${S.get('modelId')}" placeholder="手动输入模型ID"/></div>
    </div>
    <div class="sp-group">
        <h4>生成参数</h4>
        <div class="sp-row"><label>最大Token</label><input id="st-tokens" type="number" value="${S.get('maxTokens')}"/></div>
        <div class="sp-row"><label>Temperature</label><input id="st-temp" type="number" step="0.05" min="0" max="2" value="${S.get('temperature')}"/></div>
    </div>
    <div class="sp-group">
        <h4>世界书说明</h4>
        <div style="font-size:12px;color:#888;line-height:1.6;background:#F7F7F7;padding:10px;border-radius:6px;">
            只读取当前酒馆角色的世界书<br>条目key设为角色名，content中写：<br>
            <code>头像：链接</code> / <code>照片：链接1,链接2</code><br>
            <code>人设：描述</code> / <code>聊天风格：描述</code>
        </div>
    </div>
    <div class="sp-group">
        <h4>数据管理</h4>
        <div class="sp-row"><button class="sp-btn gray" onclick="W.exportData()">📤 导出数据</button></div>
        <div class="sp-row">
            <button class="sp-btn gray" onclick="document.getElementById('import-f').click()">📥 导入数据</button>
            <input type="file" id="import-f" accept=".json" style="display:none;" onchange="W.doImport(this)"/>
        </div>
        <div class="sp-row"><button class="sp-btn red" onclick="W.resetData()">🗑️ 重置所有数据</button></div>
    </div>
    <div class="sp-group"><button class="sp-btn green" onclick="W.saveSettings()">💾 保存设置</button></div>
</div>`;
        panel.classList.add('visible');
    }

    closeSettings() {
        document.getElementById('wc-settings-panel')?.classList.remove('visible');
    }

    async fetchModels() {
        S.set('apiEndpoint', document.getElementById('st-endpoint')?.value?.trim() || '');
        S.set('apiKey', document.getElementById('st-key')?.value?.trim() || '');
        this.toast('正在拉取模型...');
        const models = await API.fetchModels();
        if (models.length > 0) {
            this.toast(`已获取 ${models.length} 个模型`);
            this.openSettings();
        } else {
            this.toast('未获取到模型，请检查API配置');
        }
    }

    saveSettings() {
        S.set('apiEndpoint', document.getElementById('st-endpoint')?.value?.trim() || '');
        S.set('apiKey', document.getElementById('st-key')?.value?.trim() || '');
        const modelSelect = document.getElementById('st-model-select')?.value;
        const modelCustom = document.getElementById('st-model-custom')?.value?.trim();
        S.set('modelId', modelCustom || modelSelect || '');
        S.set('maxTokens', parseInt(document.getElementById('st-tokens')?.value) || 2048);
        S.set('temperature', parseFloat(document.getElementById('st-temp')?.value) || 0.85);
        this.toast('设置已保存');
        this.closeSettings();
    }

    exportData() {
        const data = JSON.stringify(S._s, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wechatsim_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.toast('数据已导出');
    }

    doImport(input) {
        if (!input.files?.length) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                Object.assign(S._s, data);
                S.save();
                this.toast('数据已导入');
                this.render();
                this.openSettings();
            } catch (err) {
                this.toast('导入失败：JSON无效');
            }
        };
        reader.readAsText(input.files[0]);
    }

    resetData() {
        this.modal('重置确认',
            '<div style="text-align:center;font-size:15px;">确定重置所有数据？<br><span style="color:#FA5151;font-size:13px;">此操作不可撤销！</span></div>',
            [
                { label: '取消', action: 'W.closeModal()' },
                { label: '确定重置', action: 'W.doReset()' }
            ]
        );
    }

    doReset() {
        for (const k in DEFAULTS) {
            S._s[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
        }
        S.save();
        this.closeModal();
        this.closeSettings();
        this.shopItems = [];
        this.forumPosts = [];
        this.switchTab('chats');
        this.toast('已重置所有数据');
    }
}

// ==================== 初始化 ====================
const W = new WC();
window.W = W;

jQuery(async () => {
    try {
        await W.init();
        console.log("WeChatSim: 插件已加载 v3.0");
    } catch (e) {
        console.error("WeChatSim: 初始化失败", e);
    }
});

const extensionName = EXT;
export { extensionName };
