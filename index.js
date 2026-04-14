// ============================================
// WeChatSim v3.0 - 完整重写版
// ============================================
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "WeChatSim";
const defaultSettings = {
    apiEndpoint: "",
    apiKey: "",
    modelId: "",
    availableModels: [],
    maxTokens: 2048,
    temperature: 0.85,
    playerName: "我",
    playerAvatar: "",
    playerPersona: "",
    playerId: "wxid_player",
    playerSignature: "",
    walletBalance: 8888.88,
    backpack: [],
    friends: [],
    groups: [],
    chatHistories: {},
    moments: [],
    officialAccounts: [],
    followedOA: [],
    shoppingCart: [],
    forumPosts: [],
    forumPostDetails: {},
    redpacketRecords: {},
    isOpen: false,
    unreadCount: 0,
};

// ============ 全局状态 ============
class WeChatState {
    constructor() { this.settings = {}; this.pendingMessages = 0; this.isGenerating = false; this.currentPage = "chat-list"; this.pageStack = []; }
    init() {
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        this.settings = extension_settings[extensionName];
        Object.keys(defaultSettings).forEach(k => {
            if (this.settings[k] === undefined) this.settings[k] = JSON.parse(JSON.stringify(defaultSettings[k]));
        });
        this.save();
    }
    save() { saveSettingsDebounced(); }
    get friends() { return this.settings.friends; }
    get groups() { return this.settings.groups; }
    get wallet() { return this.settings.walletBalance; }
    set wallet(v) { this.settings.walletBalance = v; this.save(); }
    getChatHistory(id) { if (!this.settings.chatHistories[id]) this.settings.chatHistories[id] = []; return this.settings.chatHistories[id]; }
    addMessage(chatId, msg) {
        const h = this.getChatHistory(chatId);
        msg.id = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        msg.timestamp = Date.now();
        h.push(msg);
        this.save();
        return msg;
    }
    getFriend(id) { return this.settings.friends.find(f => f.id === id); }
    getGroup(id) { return this.settings.groups.find(g => g.id === id); }
    addFriend(f) { if (!this.settings.friends.find(x => x.id === f.id)) { this.settings.friends.push(f); this.save(); } }
    removeFriend(id) { this.settings.friends = this.settings.friends.filter(f => f.id !== id); delete this.settings.chatHistories[id]; this.save(); }
    addToBackpack(item) {
        const e = this.settings.backpack.find(i => i.name === item.name);
        if (e) e.count = (e.count || 1) + (item.count || 1); else { item.count = item.count || 1; this.settings.backpack.push(item); }
        this.save();
    }
    removeFromBackpack(name, count = 1) {
        const i = this.settings.backpack.find(x => x.name === name);
        if (i) { i.count -= count; if (i.count <= 0) this.settings.backpack = this.settings.backpack.filter(x => x.name !== name); this.save(); return true; }
        return false;
    }
    getRedpacketRecord(msgId) { return this.settings.redpacketRecords[msgId]; }
    setRedpacketRecord(msgId, record) { this.settings.redpacketRecords[msgId] = record; this.save(); }
}
const state = new WeChatState();

// ============ 世界书读取(只读当前角色) ============
class WorldBookReader {
    static async getAllEntries() {
        try {
            const ctx = getContext();
            // 尝试通过SillyTavern API获取当前角色的世界书
            const res = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: ctx?.characters?.[ctx.characterId]?.data?.extensions?.world || '' })
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.entries) return Object.values(data.entries);
            }
        } catch (e) { /* fallback */ }

        // fallback: 从context中读
        try {
            const ctx = getContext();
            if (ctx?.worldInfo) return Array.isArray(ctx.worldInfo) ? ctx.worldInfo : Object.values(ctx.worldInfo);
        } catch (e) { }
        return [];
    }

    static async findEntry(keyword) {
        const entries = await this.getAllEntries();
        // 精确匹配key
        for (const e of entries) {
            const keys = e.key || e.keys || [];
            const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? keys.split(',') : []);
            for (const k of keyList) {
                if (k.trim().toLowerCase() === keyword.toLowerCase()) return e;
            }
        }
        // 模糊匹配
        for (const e of entries) {
            const keys = e.key || e.keys || [];
            const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? keys.split(',') : []);
            for (const k of keyList) {
                if (k.trim().toLowerCase().includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(k.trim().toLowerCase())) return e;
            }
        }
        return null;
    }

    static parseContent(content) {
        if (!content) return {};
        const d = {};
        const lines = content.split('\n');
        for (const line of lines) {
            const m = line.match(/^(头像|照片|视频|人设|聊天风格|性格|背景|名字|签名|年龄|职业|爱好|关系|备注)[：:]\s*(.+)/);
            if (m) {
                const key = m[1]; const val = m[2].trim();
                if (key === '照片' || key === '视频') d[key] = val.split(/[,，]/).map(s => s.trim()).filter(Boolean);
                else d[key] = val;
            }
        }
        // 保留原始内容
        d._raw = content;
        return d;
    }

    static async getCharacterData(name) {
        const entry = await this.findEntry(name);
        if (entry) return this.parseContent(entry.content || entry.value || '');
        return null;
    }

    static async getWorldBookSummary() {
        const entries = await this.getAllEntries();
        return entries.map(e => {
            const keys = e.key || e.keys || [];
            const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? keys.split(',') : []);
            return { keys: keyList, content: (e.content || e.value || '').substring(0, 300) };
        });
    }
}

// ============ API接口 ============
class WeChatAPI {
    static getBaseUrl() {
        let ep = (state.settings.apiEndpoint || '').trim().replace(/\/+$/, '');
        if (ep.endsWith('/v1')) return ep;
        return ep + '/v1';
    }

    static async fetchModels() {
        const base = this.getBaseUrl();
        const key = state.settings.apiKey;
        if (!base || !key) return [];
        const url = `${base}/models`;
        console.log('WeChatSim: 请求模型列表:', url);
        try {
            const r = await fetch(url, { headers: { 'Authorization': `Bearer ${key}` } });
            console.log('WeChatSim: 响应状态:', r.status);
            if (!r.ok) { console.error('WeChatSim:', await r.text()); return []; }
            const d = await r.json();
            let models = [];
            if (d.data && Array.isArray(d.data)) models = d.data.map(m => ({ id: m.id, name: m.id }));
            else if (Array.isArray(d)) models = d.map(m => ({ id: m.id || m, name: m.id || m }));
            else if (d.models) models = d.models.map(m => ({ id: m.id || m.name, name: m.id || m.name }));
            state.settings.availableModels = models;
            state.save();
            return models;
        } catch (e) { console.error('WeChatSim: 拉取模型失败', e); return []; }
    }

    static async generate(systemPrompt, messages, opts = {}) {
        const base = this.getBaseUrl();
        const key = state.settings.apiKey;
        const model = state.settings.modelId;
        if (!base || !key || !model) return "请先配置API";
        try {
            const r = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model, stream: false,
                    max_tokens: opts.maxTokens || state.settings.maxTokens,
                    temperature: opts.temperature || state.settings.temperature,
                    messages: [{ role: "system", content: systemPrompt }, ...messages]
                })
            });
            const d = await r.json();
            return d.choices?.[0]?.message?.content || "生成失败";
        } catch (e) { return "API错误: " + e.message; }
    }

    static parseJSON(raw) {
        let s = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
        try { return JSON.parse(s); } catch { return null; }
    }

    // 获取当前游玩进度摘要
    static async getProgressSummary(chatId) {
        const history = state.getChatHistory(chatId);
        const recent = history.slice(-50);
        const worldSummary = await WorldBookReader.getWorldBookSummary();

        let summary = `聊天记录摘要(最近${recent.length}条):\n`;
        recent.forEach(m => {
            if (m.type === 'text') summary += `[${m.sender}]: ${m.content}\n`;
            else if (m.type === 'system') summary += `[系统]: ${m.content}\n`;
            else summary += `[${m.sender}]: [${m.type}]\n`;
        });

        summary += `\n世界书条目摘要:\n`;
        worldSummary.forEach(e => {
            summary += `[${e.keys.join(',')}]: ${e.content}\n`;
        });

        return summary;
    }

    // 生成聊天回复
    static async generateChatReply(chatId, isGroup = false) {
        const progress = await this.getProgressSummary(chatId);
        const ctx = getContext();
        let charCard = '';
        try {
            if (ctx?.characters?.[ctx.characterId]) {
                const c = ctx.characters[ctx.characterId];
                charCard = c.description || c.data?.description || '';
            }
        } catch { }

        let chatInfo = '';
        if (isGroup) {
            const g = state.getGroup(chatId);
            if (g) chatInfo = `群聊"${g.name}"，成员：${g.members.map(m => m.name).join('、')}`;
        } else {
            const f = state.getFriend(chatId);
            if (f) {
                chatInfo = `与"${f.name}"的私聊`;
                if (f.persona) chatInfo += `\n好友人设：${f.persona}`;
                if (f.chatStyle) chatInfo += `\n聊天风格：${f.chatStyle}`;
            }
        }

        const sysPrompt = `你是微信聊天模拟器AI。根据角色卡、世界书和当前游玩进度生成回复。

角色卡设定：
${charCard.substring(0, 1000)}

${chatInfo}

玩家："${state.settings.playerName}"
${state.settings.playerPersona ? '玩家人设：' + state.settings.playerPersona : ''}

当前进度：
${progress.substring(0, 2000)}

回复要求：
1. 严格按照世界书和角色卡设定的性格、聊天风格回复
2. 参考聊天记录的上下文和进度来回复
3. 回复必须是JSON格式
4. 可以回复多条消息
5. 回复格式：
[
  {"type":"text","content":"消息","sender":"发送者名字"},
  {"type":"image","url":"图片真实URL","sender":"名字"},
  {"type":"pat","sender":"名字","target":"被拍者"},
  {"type":"redpacket","sender":"名字","greeting":"祝福语","amount":金额数字}
]
6. 群聊时不同sender表示不同人回复
7. 只输出JSON数组，不要其他内容`;

        const history = state.getChatHistory(chatId).slice(-20);
        const apiMsgs = history.map(m => ({
            role: m.sender === state.settings.playerName ? "user" : "assistant",
            content: `[${m.sender}]: ${m.type === 'text' ? m.content : '[' + m.type + ']'}`
        }));

        const raw = await this.generate(sysPrompt, apiMsgs);
        const parsed = this.parseJSON(raw);
        if (parsed) return Array.isArray(parsed) ? parsed : [parsed];

        const sender = isGroup
            ? (state.getGroup(chatId)?.members?.find(m => m.name !== state.settings.playerName)?.name || '群友')
            : (state.getFriend(chatId)?.name || '对方');
        return [{ type: "text", content: raw, sender }];
    }

    // 生成好友信息(加好友时用)
    static async generateFriendInfo(name) {
        const worldData = await WorldBookReader.getCharacterData(name);
        const worldSummary = await WorldBookReader.getWorldBookSummary();

        const sysPrompt = `根据世界书信息，为微信好友"${name}"生成详细资料。

${worldData?._raw ? '世界书中关于此人的记录：\n' + worldData._raw : '世界书中没有此人的直接记录。'}

所有世界书条目：
${worldSummary.map(e => `[${e.keys.join(',')}]: ${e.content}`).join('\n').substring(0, 1500)}

请生成JSON格式：
{
  "name": "显示名称",
  "avatar": "头像URL(如果世界书中有就用真实URL，没有就生成一个合理的描述)",
  "signature": "个性签名",
  "persona": "详细人设描述(50-100字)",
  "chatStyle": "聊天风格描述",
  "age": "年龄",
  "relation": "与玩家的关系"
}
如果世界书中有真实头像链接，必须使用真实链接。只输出JSON。`;

        const raw = await this.generate(sysPrompt, []);
        return this.parseJSON(raw);
    }

    // 生成朋友圈互动
    static async generateMomentReactions(momentText, momentImages) {
        const friends = state.settings.friends;
        if (friends.length === 0) return { likes: [], comments: [] };
        const progress = await this.getProgressSummary('moments_context');
        const sysPrompt = `玩家"${state.settings.playerName}"发了朋友圈：
"${momentText}"
${momentImages?.length > 0 ? '附带了' + momentImages.length + '张图片' : ''}

当前好友列表：${friends.map(f => f.name + (f.persona ? '(' + f.persona + ')' : '')).join('、')}

游玩进度参考：
${progress.substring(0, 1000)}

请根据每个好友的性格和与玩家的关系，生成朋友圈互动JSON：
{
  "likes":["点赞人名1","点赞人名2"],
  "comments":[
    {"sender":"评论人名","content":"评论内容"},
    {"sender":"评论人名","content":"评论内容","replyTo":"被回复人(可选)"},
    {"sender":"评论人名","content":"评论内容","image":"图片URL(可选，从世界书中找)"}
  ]
}
评论要符合每个人的性格特点。只输出JSON。`;
        const raw = await this.generate(sysPrompt, []);
        return this.parseJSON(raw) || { likes: [], comments: [] };
    }

    // 生成公众号
    static async generateOA(query) {
        const raw = await this.generate(
            `用户搜索公众号："${query}"。生成3-5个相关公众号JSON数组：
[{"name":"名称","desc":"简介(20字内)","avatar":"emoji图标"}]
只输出JSON。`, []);
        return this.parseJSON(raw) || [{ name: query, desc: "暂无简介", avatar: "📰" }];
    }

    // 生成文章
    static async generateArticles(oaName) {
        const raw = await this.generate(
            `公众号"${oaName}"推送文章。生成3篇JSON数组：
[{"title":"标题","summary":"摘要30字","content":"正文200-500字，用\\n分段","readCount":数字}]
只输出JSON。`, []);
        return this.parseJSON(raw) || [];
    }

    // 生成商品(支持搜索)
    static async generateShopItems(query = '') {
        const worldSummary = await WorldBookReader.getWorldBookSummary();
        const raw = await this.generate(
            `${query ? '用户搜索商品："' + query + '"。' : ''}参考世界书生成6-8个商品JSON数组：
世界书：${worldSummary.map(e => e.keys.join(',')).join('、').substring(0, 500)}
[{"name":"商品名","price":数字,"desc":"描述","emoji":"emoji","category":"分类"}]
商品要符合世界观设定。只输出JSON。`, []);
        return this.parseJSON(raw) || [];
    }

    // 生成论坛帖子(含回复,一次生成多条)
    static async generateForumPosts(query = '') {
        const friends = state.settings.friends;
        const worldSummary = await WorldBookReader.getWorldBookSummary();
        const raw = await this.generate(
            `${query ? '搜索论坛帖子："' + query + '"。生成类似内容的帖子。' : '生成论坛帖子。'}
论坛用户：${friends.map(f => f.name).join('、') || '匿名用户'}
世界书参考：${worldSummary.map(e => e.keys.join(',') + ':' + e.content.substring(0, 100)).join('\n').substring(0, 800)}

生成5-8条帖子，每条帖子包含3-5条回复，JSON数组：
[{
  "id":"post_1",
  "author":"发帖人",
  "title":"标题",
  "content":"内容50-200字",
  "likes":数字,
  "time":"时间如'2小时前'",
  "replies":[
    {"author":"回复人","content":"回复内容","time":"时间","likes":数字},
    {"author":"回复人","content":"回复内容","time":"时间","likes":数字}
  ]
}]
帖子和回复要符合世界观，风格参考角色卡。只输出JSON。`, []);
        const parsed = this.parseJSON(raw);
        if (parsed && Array.isArray(parsed)) {
            // 存储详情
            parsed.forEach(p => {
                if (p.id) state.settings.forumPostDetails[p.id] = p;
            });
            state.save();
        }
        return parsed || [];
    }
}

// ============ SVG图标 ============
const I = {
    wechat: `<svg viewBox="0 0 24 24"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 01.213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.328.328 0 00.167-.054l1.903-1.114a.864.864 0 01.717-.098 10.16 10.16 0 002.837.403c.276 0 .543-.027.811-.05a6.577 6.577 0 01-.253-1.82c0-3.697 3.37-6.694 7.527-6.694.259 0 .508.025.764.042C16.833 4.905 13.147 2.188 8.691 2.188zm-2.87 4.401a1.026 1.026 0 11-.001 2.052 1.026 1.026 0 010-2.052zm5.742 0a1.026 1.026 0 110 2.052 1.026 1.026 0 010-2.052zm4.198 2.908c-3.732 0-6.759 2.654-6.759 5.93 0 3.274 3.027 5.93 6.76 5.93.867 0 1.7-.143 2.47-.402a.73.73 0 01.604.083l1.61.943a.276.276 0 00.142.046c.134 0 .244-.111.244-.248 0-.06-.024-.12-.04-.18l-.33-1.252a.498.498 0 01.18-.56C20.88 18.682 21.9 16.906 21.9 15.43c.002-3.278-3.025-5.932-6.759-5.932h.001zm-2.926 3.28a.868.868 0 110 1.735.868.868 0 010-1.735zm5.088 0a.868.868 0 110 1.736.868.868 0 010-1.736z"/></svg>`,
    back: `<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`,
    more: `<svg viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>`,
    image: `<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`,
    video: `<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
    emoji: `<svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>`,
    send: `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
    camera: `<svg viewBox="0 0 24 24"><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>`,
    contacts: `<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
    discover: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`,
    me: `<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    wallet: `<svg viewBox="0 0 24 24"><path d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
    gift: `<svg viewBox="0 0 24 24"><path d="M20 6h-2.18c.11-.31.18-.65.18-1 0-1.66-1.34-3-3-3-1.05 0-1.96.54-2.5 1.35l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 12 7.4l3.38 4.6L17 10.83 14.92 8H20v6z"/></svg>`,
    shop: `<svg viewBox="0 0 24 24"><path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/></svg>`,
    forum: `<svg viewBox="0 0 24 24"><path d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`,
    addFriend: `<svg viewBox="0 0 24 24"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    edit: `<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`,
    backpack: `<svg viewBox="0 0 24 24"><path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
    search: `<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`,
    like: `<svg viewBox="0 0 24 24"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-1.91l-.01-.01L23 10z"/></svg>`,
    article: `<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`,
    reply: `<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`,
};

// ============ 辅助函数 ============
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escA(s) { return (s || '').replace(/'/g, "\\'").replace(/"/g, '\\"'); }
function defAvatar(name) {
    const c = ['#07C160', '#FA5151', '#576B95', '#FF8800', '#C44AFF', '#00BFFF'];
    let h = 0; for (let i = 0; i < (name || '').length; i++) h = ((h << 5) - h) + name.charCodeAt(i) | 0;
    const cl = c[Math.abs(h) % c.length]; const ch = (name || '?')[0];
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="${cl}" width="100" height="100" rx="8"/><text x="50" y="62" fill="white" font-size="45" font-family="Arial" text-anchor="middle" font-weight="bold">${ch}</text></svg>`)}`;
}
function fmtTime(ts) {
    if (!ts) return ''; const d = new Date(ts); const n = new Date(); const diff = n - d;
    if (diff < 60000) return '刚刚'; if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
}
function nowStr() { const n = new Date(); return `${n.getHours().toString().padStart(2, '0')}:${n.getMinutes().toString().padStart(2, '0')}`; }

// ============ 主控制器 ============
class WeChatSimApp {
    constructor() {
        this.chatId = null; this.chatIsGroup = false;
        this.oaName = ''; this.oaArticles = [];
        this.shopItems = []; this.forumPosts = [];
        this.momentImages = []; this.currentArticle = null;
        this.contactId = null; this.currentForumPost = null;
    }

    async init() {
        state.init();
        this.createDOM();
        setInterval(() => { const t = document.querySelector('.ws-statusbar .time'); if (t) t.textContent = nowStr(); }, 30000);
    }

    createDOM() {
        const c = document.createElement('div');
        c.id = 'ws-container';
        c.innerHTML = `
            <button id="ws-reply-btn" onclick="WS.triggerGenerate()">💬 生成回复</button>
            <div id="ws-phone"><div id="ws-screen"></div></div>
            <button id="ws-toggle" onclick="WS.toggle()">${I.wechat}</button>
            <div id="ws-settings-panel"></div>`;
        document.body.appendChild(c);
        this.phone = document.getElementById('ws-phone');
        this.render();
    }

    toggle() {
        this.phone.classList.toggle('active');
        if (this.phone.classList.contains('active')) this.render();
    }

    render() {
        const s = document.getElementById('ws-screen');
        if (!s) return;
        const p = state.currentPage;
        const map = {
            'chat-list': () => this.pgChatList(),
            'contacts': () => this.pgContacts(),
            'discover': () => this.pgDiscover(),
            'me': () => this.pgMe(),
            'chat': () => this.pgChat(),
            'moments': () => this.pgMoments(),
            'compose-moment': () => this.pgComposeMoment(),
            'wallet': () => this.pgWallet(),
            'backpack': () => this.pgBackpack(),
            'oa-list': () => this.pgOAList(),
            'oa-detail': () => this.pgOADetail(),
            'article': () => this.pgArticle(),
            'shop': () => this.pgShop(),
            'forum': () => this.pgForum(),
            'forum-post': () => this.pgForumPost(),
            'profile': () => this.pgProfile(),
            'persona': () => this.pgPersona(),
        };
        s.innerHTML = (map[p] || map['chat-list'])();
        if (p === 'chat') { this.scrollChat(); this.updateReplyBtn(); }
        else { document.getElementById('ws-reply-btn')?.classList.remove('show'); }
    }

    nav(page) { state.pageStack.push(state.currentPage); state.currentPage = page; this.render(); }
    goBack() { state.currentPage = state.pageStack.pop() || 'chat-list'; this.render(); }
    tab(t) { const m = { chats: 'chat-list', contacts: 'contacts', discover: 'discover', me: 'me' }; state.currentPage = m[t]; state.pageStack = []; this.render(); }

    statusBar() { return `<div class="ws-statusbar"><span class="time">${nowStr()}</span><span>📶🔋</span></div>`; }
    navbar(title, back = false, actions = '') {
        return `<div class="ws-navbar">${back ? `<button class="ws-nav-back" onclick="WS.goBack()">${I.back}</button>` : '<div></div>'}<div class="ws-nav-title">${title}</div><div class="ws-nav-actions">${actions}</div></div>`;
    }
    tabbar(active) {
        const tabs = [['chats', '微信', I.wechat], ['contacts', '通讯录', I.contacts], ['discover', '发现', I.discover], ['me', '我', I.me]];
        return `<div class="ws-tabbar">${tabs.map(([id, label, icon]) => `<button class="ws-tab ${active === id ? 'active' : ''}" onclick="WS.tab('${id}')">${icon}<span>${label}</span></button>`).join('')}</div>`;
    }
    toast(msg) {
        const e = document.createElement('div'); e.className = 'ws-toast'; e.textContent = msg;
        this.phone.querySelector('#ws-screen')?.appendChild(e);
        setTimeout(() => e.remove(), 2200);
    }

    // ======== 上传辅助 ========
    uploadFile(accept, callback) {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept;
        inp.onchange = (e) => {
            if (!e.target.files?.length) return;
            const reader = new FileReader();
            reader.onload = (ev) => callback(ev.target.result);
            reader.readAsDataURL(e.target.files[0]);
        };
        inp.click();
    }

    uploadMultiFiles(accept, callback) {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept; inp.multiple = true;
        inp.onchange = (e) => {
            Array.from(e.target.files).forEach(file => {
                const reader = new FileReader();
                reader.onload = (ev) => callback(ev.target.result);
                reader.readAsDataURL(file);
            });
        };
        inp.click();
    }

    // ======== 模态框 ========
    modal(title, body, buttons = []) {
        const o = document.createElement('div'); o.className = 'ws-modal-overlay';
        o.innerHTML = `<div class="ws-modal"><div class="ws-modal-hd">${title}</div><div class="ws-modal-bd">${body}</div><div class="ws-modal-ft">${buttons.map(b => `<button onclick="${b.action}" style="${b.style || ''}">${b.label}</button>`).join('')}</div></div>`;
        document.getElementById('ws-screen')?.appendChild(o);
    }
    closeModal() { document.querySelector('.ws-modal-overlay')?.remove(); }

    // ======== 回复按钮(手机左侧) ========
    updateReplyBtn() {
        const btn = document.getElementById('ws-reply-btn');
        if (!btn) return;
        const show = ['chat', 'moments'].includes(state.currentPage) && state.pendingMessages > 0;
        btn.classList.toggle('show', show);
        if (show) btn.textContent = `💬 生成回复${state.pendingMessages > 0 ? ' (' + state.pendingMessages + ')' : ''}`;
    }

    async triggerGenerate() {
        if (state.isGenerating) return;
        state.isGenerating = true;
        const btn = document.getElementById('ws-reply-btn');
        btn.classList.add('loading'); btn.textContent = '⏳ 生成中...';

        try {
            if (state.currentPage === 'chat' && this.chatId) {
                const replies = await WeChatAPI.generateChatReply(this.chatId, this.chatIsGroup);
                for (const r of replies) {
                    const sender = r.sender || (this.chatIsGroup
                        ? (state.getGroup(this.chatId)?.members?.find(m => m.name !== state.settings.playerName)?.name || '群友')
                        : (state.getFriend(this.chatId)?.name || '对方'));
                    if (r.type === 'image') {
                        let url = r.url;
                        if (!url || url.includes('描述') || url.length < 10) {
                            const wd = await WorldBookReader.getCharacterData(sender);
                            if (wd?.照片?.length) url = wd.照片[Math.floor(Math.random() * wd.照片.length)];
                        }
                        state.addMessage(this.chatId, { type: 'image', url: url || '', sender });
                    } else if (r.type === 'video') {
                        let url = r.url;
                        if (!url || url.length < 10) {
                            const wd = await WorldBookReader.getCharacterData(sender);
                            if (wd?.视频?.length) url = wd.视频[Math.floor(Math.random() * wd.视频.length)];
                        }
                        state.addMessage(this.chatId, { type: 'video', url: url || '', sender });
                    } else if (r.type === 'pat') {
                        state.addMessage(this.chatId, { type: 'pat', sender: r.sender || sender, target: r.target || state.settings.playerName });
                    } else if (r.type === 'redpacket') {
                        state.addMessage(this.chatId, { type: 'redpacket', sender, greeting: r.greeting || '恭喜发财', amount: r.amount || (Math.random() * 10).toFixed(2) * 1, opened: false });
                    } else {
                        state.addMessage(this.chatId, { type: 'text', content: r.content || r.text || '', sender });
                    }
                }
            } else if (state.currentPage === 'moments') {
                // 重新生成最新朋友圈的互动
                const lastM = state.settings.moments[state.settings.moments.length - 1];
                if (lastM) {
                    const reactions = await WeChatAPI.generateMomentReactions(lastM.text, lastM.images);
                    lastM.likes = reactions.likes || [];
                    lastM.comments = reactions.comments || [];
                    state.save();
                }
            }
            state.pendingMessages = 0;
        } catch (e) { console.error(e); this.toast('生成失败'); }

        state.isGenerating = false;
        btn.classList.remove('loading');
        this.render();
    }

    scrollChat() { setTimeout(() => { const c = document.getElementById('ws-chat-msgs'); if (c) c.scrollTop = c.scrollHeight; }, 50); }

    // ================================================================
    //  页面渲染
    // ================================================================

    pgChatList() {
        const chats = [];
        state.settings.friends.forEach(f => {
            const h = state.getChatHistory(f.id); const last = h[h.length - 1];
            chats.push({ id: f.id, name: f.name, avatar: f.avatar || defAvatar(f.name), lastMsg: last ? (last.type === 'text' ? last.content : `[${last.type}]`) : '', time: last ? fmtTime(last.timestamp) : '', ts: last?.timestamp || 0, isGroup: false });
        });
        state.settings.groups.forEach(g => {
            const h = state.getChatHistory(g.id); const last = h[h.length - 1];
            chats.push({ id: g.id, name: g.name, avatar: g.avatar || defAvatar(g.name), lastMsg: last ? `${last.sender || ''}: ${last.type === 'text' ? last.content : '[' + last.type + ']'}` : '', time: last ? fmtTime(last.timestamp) : '', ts: last?.timestamp || 0, isGroup: true });
        });
        chats.sort((a, b) => b.ts - a.ts);

        return `${this.statusBar()}${this.navbar('微信', false, `<button onclick="WS.showAddMenu()">${I.plus}</button>`)}
        <div class="ws-screen-body">
            <div class="ws-search"><input placeholder="搜索" oninput="WS.searchChats(this.value)"/></div>
            <div id="ws-chat-items">
                ${chats.map(c => `<div class="ws-chat-item" onclick="WS.openChat('${c.id}',${c.isGroup})">
                    <img src="${c.avatar}" onerror="this.src='${defAvatar(c.name)}'" class="ws-avatar"/>
                    <div class="ws-chat-info"><div class="ws-chat-name"><span>${esc(c.name)}</span><span class="ws-chat-time">${c.time}</span></div><div class="ws-chat-preview">${esc(c.lastMsg).substring(0, 28)}</div></div>
                </div>`).join('')}
                ${chats.length === 0 ? '<div class="ws-empty">暂无聊天<br>点击右上角 + 添加好友</div>' : ''}
            </div>
        </div>${this.tabbar('chats')}`;
    }

    pgChat() {
        const info = this.chatIsGroup ? state.getGroup(this.chatId) : state.getFriend(this.chatId);
        if (!info) return this.pgChatList();
        const h = state.getChatHistory(this.chatId);
        const title = info.name + (this.chatIsGroup ? ` (${info.members?.length || 0})` : '');

        const msgs = h.map((m, i) => {
            const isSelf = m.sender === state.settings.playerName;
            const av = isSelf ? (state.settings.playerAvatar || defAvatar(state.settings.playerName))
                : (this.chatIsGroup ? (info.members?.find(x => x.name === m.sender)?.avatar || defAvatar(m.sender || '')) : (info.avatar || defAvatar(info.name)));

            let timeLabel = '';
            if (i === 0 || (m.timestamp - h[i - 1].timestamp > 300000))
                timeLabel = `<div class="ws-time-label">${fmtTime(m.timestamp)}</div>`;

            if (m.type === 'system') return `${timeLabel}<div class="ws-sys-msg">${esc(m.content)}</div>`;
            if (m.type === 'pat') return `${timeLabel}<div class="ws-sys-msg">"${esc(m.sender)}" 拍了拍 "${esc(m.target)}"</div>`;

            const senderLabel = !isSelf && this.chatIsGroup ? `<div class="ws-sender-name">${esc(m.sender)}</div>` : '';

            if (m.type === 'redpacket') {
                const rec = state.getRedpacketRecord(m.id);
                return `${timeLabel}<div class="ws-msg-row ${isSelf ? 'self' : ''}">
                    <img class="ws-msg-avatar" src="${av}" onerror="this.src='${defAvatar(m.sender || '')}'" onclick="WS.viewProfile('${escA(m.sender)}')"/>
                    <div class="ws-msg-wrap">${senderLabel}
                        <div class="ws-bubble ws-rp ${rec ? 'opened' : ''}" onclick="WS.openRedPacket('${m.id}')">
                            <div class="ws-rp-body">🧧 <span>${esc(m.greeting || '恭喜发财')}</span></div>
                            <div class="ws-rp-foot">微信红包${rec ? ' · 已领取' : ''}</div>
                        </div></div></div>`;
            }
            if (m.type === 'gift') {
                return `${timeLabel}<div class="ws-msg-row ${isSelf ? 'self' : ''}">
                    <img class="ws-msg-avatar" src="${av}" onerror="this.src='${defAvatar(m.sender || '')}'" />
                    <div class="ws-msg-wrap">${senderLabel}
                        <div class="ws-bubble ws-gift"><div style="font-size:32px">${m.emoji || '🎁'}</div><div class="ws-gift-name">${esc(m.giftName || '礼物')}</div></div></div></div>`;
            }
            if (m.type === 'image') {
                return `${timeLabel}<div class="ws-msg-row ${isSelf ? 'self' : ''}">
                    <img class="ws-msg-avatar" src="${av}" onerror="this.src='${defAvatar(m.sender || '')}'" onclick="WS.viewProfile('${escA(m.sender)}')"/>
                    <div class="ws-msg-wrap">${senderLabel}
                        <div class="ws-bubble ws-img-msg"><img src="${m.url}" onerror="this.alt='图片'" onclick="WS.viewImage('${escA(m.url)}')"/></div></div></div>`;
            }
            if (m.type === 'video') {
                return `${timeLabel}<div class="ws-msg-row ${isSelf ? 'self' : ''}">
                    <img class="ws-msg-avatar" src="${av}" onerror="this.src='${defAvatar(m.sender || '')}'" />
                    <div class="ws-msg-wrap">${senderLabel}
                        <div class="ws-bubble ws-vid-msg" onclick="WS.playVideo('${escA(m.url)}')"><video src="${m.url}" preload="metadata"></video><div class="ws-play-icon">${I.play}</div></div></div></div>`;
            }
            let content = esc(m.content || '').replace(/@(\S+)/g, '<span class="ws-at">@$1</span>');
            return `${timeLabel}<div class="ws-msg-row ${isSelf ? 'self' : ''}">
                <img class="ws-msg-avatar" src="${av}" onerror="this.src='${defAvatar(m.sender || '')}'" onclick="WS.viewProfile('${escA(m.sender)}')"/>
                <div class="ws-msg-wrap">${senderLabel}<div class="ws-bubble">${content}</div></div></div>`;
        }).join('');

        return `${this.statusBar()}${this.navbar(title, true, `<button onclick="WS.chatMenu()">${I.more}</button>`)}
        <div class="ws-screen-body" style="padding:0;display:flex;flex-direction:column;">
            <div class="ws-chat-msgs" id="ws-chat-msgs">${msgs}</div>
            <div class="ws-input-bar">
                <textarea id="ws-input" rows="1" placeholder="输入消息..." oninput="WS.onInput(this)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();WS.sendMsg()}"></textarea>
                <button id="ws-send-btn" class="ws-send-btn" onclick="WS.sendMsg()">发送</button>
                <button onclick="WS.toggleMore()">${I.plus}</button>
            </div>
            <div class="ws-more-panel" id="ws-more-panel">
                <div class="ws-more-item" onclick="WS.sendPhoto()"><div class="ws-more-icon">${I.image}</div><span>照片</span></div>
                <div class="ws-more-item" onclick="WS.sendVideoDialog()"><div class="ws-more-icon">${I.video}</div><span>视频</span></div>
                <div class="ws-more-item" onclick="WS.sendRedPacketDialog()"><div class="ws-more-icon" style="background:#FA9D3B">🧧</div><span>红包</span></div>
                <div class="ws-more-item" onclick="WS.sendGiftDialog()"><div class="ws-more-icon" style="background:#C44AFF">${I.gift}</div><span>礼物</span></div>
                <div class="ws-more-item" onclick="WS.doPat()"><div class="ws-more-icon" style="background:#FF8800">👋</div><span>拍一拍</span></div>
                ${this.chatIsGroup ? '<div class="ws-more-item" onclick="WS.atSomeone()"><div class="ws-more-icon" style="background:#576B95">@</div><span>@某人</span></div>' : ''}
                <div class="ws-more-item" onclick="WS.sendFromBackpack()"><div class="ws-more-icon" style="background:#07C160">${I.backpack}</div><span>背包</span></div>
            </div>
        </div>`;
    }

    pgContacts() {
        const fs = [...state.settings.friends].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        return `${this.statusBar()}${this.navbar('通讯录', false, `<button onclick="WS.addFriendDialog()">${I.addFriend}</button>`)}
        <div class="ws-screen-body">
            <div class="ws-search"><input placeholder="搜索"/></div>
            <div class="ws-feat-item" onclick="WS.addFriendDialog()"><div class="ws-feat-icon" style="background:#FA9D3B">${I.addFriend}</div><span>新的朋友</span></div>
            <div class="ws-feat-item" onclick="WS.showGroupList()"><div class="ws-feat-icon" style="background:#07C160">${I.contacts}</div><span>群聊</span></div>
            <div class="ws-section-hd">好友 (${fs.length})</div>
            ${fs.map(f => `<div class="ws-contact-item" onclick="WS.viewContactProfile('${f.id}')">
                <img class="ws-avatar" src="${f.avatar || defAvatar(f.name)}" onerror="this.src='${defAvatar(f.name)}'"/><span>${f.name}</span>
            </div>`).join('')}
            ${fs.length === 0 ? '<div class="ws-empty">暂无好友</div>' : ''}
        </div>${this.tabbar('contacts')}`;
    }

    pgDiscover() {
        return `${this.statusBar()}${this.navbar('发现')}
        <div class="ws-screen-body ws-discover">
            <div class="ws-disc-group">
                <div class="ws-disc-item" onclick="WS.nav('moments')"><span>📷</span><span>朋友圈</span><span>›</span></div>
            </div>
            <div class="ws-disc-group">
                <div class="ws-disc-item" onclick="WS.nav('oa-list')"><span>📰</span><span>公众号</span><span>›</span></div>
            </div>
            <div class="ws-disc-group">
                <div class="ws-disc-item" onclick="WS.openShop()"><span>🛒</span><span>购物</span><span>›</span></div>
            </div>
            <div class="ws-disc-group">
                <div class="ws-disc-item" onclick="WS.openForum()"><span>💬</span><span>论坛</span><span>›</span></div>
            </div>
        </div>${this.tabbar('discover')}`;
    }

    pgMe() {
        const av = state.settings.playerAvatar || defAvatar(state.settings.playerName);
        return `${this.statusBar()}${this.navbar('我')}
        <div class="ws-screen-body ws-me">
            <div class="ws-me-card" onclick="WS.nav('persona')">
                <img class="ws-me-avatar" src="${av}" onerror="this.src='${defAvatar(state.settings.playerName)}'" onclick="event.stopPropagation();WS.changeMyAvatar()"/>
                <div><div class="ws-me-name">${state.settings.playerName}</div><div class="ws-me-id">微信号: ${state.settings.playerId}</div></div>
            </div>
            <div class="ws-menu-group">
                <div class="ws-menu-item" onclick="WS.nav('wallet')"><span>${I.wallet}</span><span>钱包</span><span>¥${state.settings.walletBalance.toFixed(2)}</span><span>›</span></div>
            </div>
            <div class="ws-menu-group">
                <div class="ws-menu-item" onclick="WS.nav('backpack')"><span>${I.backpack}</span><span>背包</span><span>${state.settings.backpack.length}件</span><span>›</span></div>
            </div>
            <div class="ws-menu-group">
                <div class="ws-menu-item" onclick="WS.nav('persona')"><span>${I.edit}</span><span>个人人设</span><span></span><span>›</span></div>
                <div class="ws-menu-item" onclick="WS.openSettings()"><span>${I.settings}</span><span>插件设置</span><span></span><span>›</span></div>
            </div>
        </div>${this.tabbar('me')}`;
    }

    pgMoments() {
        const ms = [...state.settings.moments].reverse();
        const av = state.settings.playerAvatar || defAvatar(state.settings.playerName);
        return `${this.statusBar()}${this.navbar('朋友圈', true, `<button onclick="WS.nav('compose-moment')">${I.camera}</button>`)}
        <div class="ws-screen-body ws-moments">
            <div class="ws-moments-hd">
                <div class="ws-moments-cover"></div>
                <div class="ws-moments-profile"><span>${state.settings.playerName}</span><img src="${av}" onerror="this.src='${defAvatar(state.settings.playerName)}'"/></div>
            </div>
            ${ms.map(m => {
            const mav = m.avatar || defAvatar(m.author);
            const imgs = m.images?.length > 0 ? `<div class="ws-moment-imgs cols-${Math.min(m.images.length, 3)}">${m.images.map(img => `<img src="${img}" onerror="this.style.display='none'" onclick="WS.viewImage('${escA(img)}')" />`).join('')}</div>` : '';
            const interactions = (m.likes?.length > 0 || m.comments?.length > 0) ? `<div class="ws-moment-interact">
                ${m.likes?.length > 0 ? `<div class="ws-moment-likes">❤️ ${m.likes.map(n => `<span class="ws-link">${n}</span>`).join('，')}</div>` : ''}
                ${m.comments?.length > 0 ? `<div class="ws-moment-comments">${m.comments.map(c => `<div class="ws-moment-comment"><span class="ws-link">${c.sender}</span>${c.replyTo ? ' 回复 <span class="ws-link">' + c.replyTo + '</span>' : ''}：${esc(c.content)}${c.image ? ' <img src="' + c.image + '" style="max-width:80px;border-radius:4px;display:block;margin-top:2px;"/>' : ''}</div>`).join('')}</div>` : ''}
            </div>` : '';
            return `<div class="ws-moment-item"><img class="ws-moment-av" src="${mav}" onerror="this.src='${defAvatar(m.author)}'"/>
                <div class="ws-moment-body"><div class="ws-link ws-moment-name">${m.author}</div><div class="ws-moment-text">${esc(m.text)}</div>${imgs}
                <div class="ws-moment-time-row"><span class="ws-gray">${fmtTime(m.timestamp)}</span><button class="ws-moment-act" onclick="WS.likeMoment('${m.id}')">${I.like}</button></div>${interactions}</div></div>`;
        }).join('')}
            ${ms.length === 0 ? '<div class="ws-empty" style="padding:40px">朋友圈空空如也~</div>' : ''}
        </div>`;
    }

    pgComposeMoment() {
        return `${this.statusBar()}${this.navbar('', true, '<button onclick="WS.publishMoment()" class="ws-btn-green">发表</button>')}
        <div class="ws-screen-body" style="background:white;padding:16px;">
            <textarea id="ws-moment-text" placeholder="这一刻的想法..." style="width:100%;min-height:120px;border:none;outline:none;font-size:16px;resize:none;box-sizing:border-box;font-family:inherit;"></textarea>
            <div id="ws-compose-imgs" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
                ${this.momentImages.map(img => `<img src="${img}" style="width:70px;height:70px;object-fit:cover;border-radius:4px;"/>`).join('')}
                <div style="width:70px;height:70px;border:1px dashed #ccc;border-radius:4px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:24px;color:#ccc;" onclick="WS.addMomentImg()">+</div>
            </div>
            <input class="ws-input" id="ws-moment-img-url" placeholder="输入图片链接后点 +" style="margin-top:10px;"/>
        </div>`;
    }

    pgWallet() {
        return `${this.statusBar()}${this.navbar('钱包', true)}
        <div class="ws-screen-body" style="background:#EDEDED;"><div class="ws-wallet-card"><div class="ws-wallet-label">余额</div><div class="ws-wallet-amt">¥${state.settings.walletBalance.toFixed(2)}</div></div>
        <div class="ws-wallet-actions">
            <div onclick="WS.walletRecharge()"><div class="ws-wallet-act-icon">${I.plus}</div><span>充值</span></div>
            <div onclick="WS.walletTransfer()"><div class="ws-wallet-act-icon">${I.send}</div><span>转账</span></div>
        </div></div>`;
    }

    pgBackpack() {
        const items = state.settings.backpack;
        return `${this.statusBar()}${this.navbar('背包', true)}
        <div class="ws-screen-body" style="padding:12px;background:#EDEDED;">
            ${items.length > 0 ? `<div class="ws-bp-grid">${items.map(i => `<div class="ws-bp-item" onclick="WS.useItem('${escA(i.name)}')"><div style="font-size:32px">${i.emoji || '📦'}</div><div class="ws-bp-name">${i.name}</div>${i.count > 1 ? `<span class="ws-bp-count">×${i.count}</span>` : ''}</div>`).join('')}</div>` : '<div class="ws-empty">背包空空如也</div>'}
        </div>`;
    }

    pgOAList() {
        const followed = state.settings.followedOA || [];
        return `${this.statusBar()}${this.navbar('公众号', true)}
        <div class="ws-screen-body">
            <div class="ws-search" style="position:relative;"><input id="ws-oa-search" placeholder="搜索公众号"/><button onclick="WS.searchOA()" class="ws-search-btn">搜索</button></div>
            ${followed.length > 0 ? `<div class="ws-section-hd">已关注</div>${followed.map(oa => `<div class="ws-contact-item" onclick="WS.openOA('${escA(oa.name)}')"><div style="width:40px;height:40px;border-radius:50%;background:#07C160;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">${oa.avatar || '📰'}</div><span>${oa.name}</span></div>`).join('')}` : ''}
            <div id="ws-oa-results"></div>
            ${followed.length === 0 ? '<div class="ws-empty">搜索并关注公众号</div>' : ''}
        </div>`;
    }

    pgOADetail() {
        return `${this.statusBar()}${this.navbar(this.oaName, true, '<button onclick="WS.pushArticles()" class="ws-btn-green">推送</button>')}
        <div class="ws-screen-body">
            <div style="padding:12px;text-align:center;background:white;margin-bottom:8px;"><button onclick="WS.followOA()" class="ws-btn-green" style="padding:6px 24px;">关注</button></div>
            <div id="ws-articles">${(this.oaArticles || []).map(a => `<div class="ws-article-item" onclick='WS.readArticle(${JSON.stringify(a).replace(/'/g, "&#39;")})'><div class="ws-article-title">${esc(a.title)}</div><div class="ws-article-desc">${esc(a.summary || '')}</div></div>`).join('')}
            ${(!this.oaArticles || this.oaArticles.length === 0) ? '<div class="ws-empty">点击推送按钮获取文章</div>' : ''}</div>
        </div>`;
    }

    pgArticle() {
        if (!this.currentArticle) return this.pgOADetail();
        const a = this.currentArticle;
        return `${this.statusBar()}${this.navbar('文章', true)}
        <div class="ws-screen-body" style="background:white;padding:16px;"><h2 style="font-size:20px;font-weight:700;margin:0 0 12px;">${esc(a.title)}</h2><div style="font-size:13px;color:#888;margin-bottom:16px;border-bottom:1px solid #eee;padding-bottom:12px;">阅读 ${a.readCount || Math.floor(Math.random() * 10000)}</div><div style="font-size:15px;line-height:1.8;">${(a.content || '').split('\n').map(p => `<p>${esc(p)}</p>`).join('')}</div></div>`;
    }

    pgShop() {
        const cart = state.settings.shoppingCart;
        const cartCount = cart.reduce((s, c) => s + c.qty, 0);
        const cartTotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
        return `${this.statusBar()}${this.navbar('购物', true)}
        <div class="ws-screen-body" style="padding-bottom:50px;">
            <div style="padding:8px 12px;background:white;display:flex;gap:8px;"><input id="ws-shop-search" class="ws-shop-search" placeholder="搜索商品"/><button onclick="WS.searchShop()" class="ws-btn-green" style="padding:4px 12px;font-size:13px;flex-shrink:0;">搜索</button></div>
            <div class="ws-shop-grid" id="ws-shop-items">${(this.shopItems || []).map(i => `<div class="ws-shop-item" onclick="WS.addToCart('${escA(i.name)}',${i.price},'${i.emoji || '📦'}')"><div class="ws-shop-img">${i.emoji || '📦'}</div><div class="ws-shop-info"><div class="ws-shop-name">${esc(i.name)}</div><div class="ws-shop-price">¥${i.price}</div></div></div>`).join('')}
                ${this.shopItems.length === 0 ? '<div class="ws-empty" style="grid-column:1/-1;">搜索或等待加载商品...</div>' : ''}
            </div>
            <div class="ws-cart-bar"><div onclick="WS.toggleCartPanel()" style="cursor:pointer;position:relative;">${I.shop}${cartCount > 0 ? `<span class="ws-cart-badge">${cartCount}</span>` : ''}</div><div class="ws-cart-total">¥${cartTotal.toFixed(2)}</div><button class="ws-btn-green" onclick="WS.checkout()">结算(${cartCount})</button></div>
            <div class="ws-cart-panel" id="ws-cart-panel" style="display:none;">
                <div style="display:flex;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #eee;"><span>购物车</span><button onclick="WS.clearCart()" style="background:none;border:none;color:#888;cursor:pointer;">清空</button></div>
                ${cart.map(c => `<div class="ws-cart-item"><span>${c.emoji || ''} ${c.name}</span><span style="color:#FA5151">¥${c.price}</span><div class="ws-qty-ctrl"><button onclick="WS.cartQty('${escA(c.name)}',-1)">-</button><span>${c.qty}</span><button onclick="WS.cartQty('${escA(c.name)}',1)">+</button></div></div>`).join('')}
            </div>
        </div>`;
    }

    pgForum() {
        return `${this.statusBar()}${this.navbar('论坛', true, '<button onclick="WS.refreshForum()" class="ws-btn-green" style="font-size:12px">刷新</button>')}
        <div class="ws-screen-body">
            <div class="ws-search" style="position:relative;"><input id="ws-forum-search" placeholder="搜索帖子"/><button onclick="WS.searchForum()" class="ws-search-btn">搜索</button></div>
            ${(this.forumPosts || []).map(p => `<div class="ws-forum-post" onclick="WS.openForumPost('${escA(p.id || '')}')">
                <div class="ws-forum-header"><img class="ws-forum-av" src="${defAvatar(p.author)}"/><div><div class="ws-link">${p.author}</div><div class="ws-gray" style="font-size:12px">${p.time || '刚刚'}</div></div></div>
                <div class="ws-forum-title">${esc(p.title)}</div>
                <div class="ws-forum-content">${esc(p.content).substring(0, 100)}${(p.content || '').length > 100 ? '...' : ''}</div>
                <div class="ws-forum-stats"><span>${I.like} ${p.likes || 0}</span><span>💬 ${p.replies?.length || 0}条回复</span></div>
            </div>`).join('')}
            ${this.forumPosts.length === 0 ? '<div class="ws-empty">点击刷新加载帖子</div>' : ''}
        </div>`;
    }

    pgForumPost() {
        const p = this.currentForumPost;
        if (!p) return this.pgForum();
        return `${this.statusBar()}${this.navbar('帖子详情', true)}
        <div class="ws-screen-body" style="background:#EDEDED;">
            <div style="background:white;padding:16px;margin-bottom:8px;">
                <div class="ws-forum-header"><img class="ws-forum-av" src="${defAvatar(p.author)}"/><div><div class="ws-link" style="font-size:16px;font-weight:600;">${p.author}</div><div class="ws-gray" style="font-size:12px">${p.time || '刚刚'}</div></div></div>
                <h3 style="margin:12px 0 8px;font-size:18px;">${esc(p.title)}</h3>
                <div style="font-size:15px;line-height:1.6;color:#333;">${esc(p.content)}</div>
                <div class="ws-forum-stats" style="margin-top:12px;"><span>${I.like} ${p.likes || 0}</span></div>
            </div>
            <div style="background:white;padding:12px 16px;">
                <div style="font-size:14px;font-weight:600;margin-bottom:10px;">回复 (${p.replies?.length || 0})</div>
                ${(p.replies || []).map(r => `<div style="display:flex;gap:8px;padding:10px 0;border-bottom:1px solid #f0f0f0;">
                    <img src="${defAvatar(r.author)}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;"/>
                    <div><div class="ws-link" style="font-size:13px;font-weight:600;">${r.author}</div><div style="font-size:14px;line-height:1.5;margin-top:2px;">${esc(r.content)}</div><div class="ws-gray" style="font-size:11px;margin-top:4px;">${r.time || ''} · ${I.like} ${r.likes || 0}</div></div>
                </div>`).join('')}
            </div>
        </div>`;
    }

    pgProfile() {
        const f = state.getFriend(this.contactId);
        if (!f) return this.pgContacts();
        return `${this.statusBar()}${this.navbar('详细资料', true)}
        <div class="ws-screen-body" style="background:#EDEDED;">
            <div style="background:white;padding:20px 16px;display:flex;gap:16px;align-items:center;">
                <img src="${f.avatar || defAvatar(f.name)}" onerror="this.src='${defAvatar(f.name)}'" style="width:64px;height:64px;border-radius:8px;object-fit:cover;cursor:pointer;" onclick="WS.changeFriendAvatar('${f.id}')"/>
                <div><h3 style="margin:0 0 4px;font-size:20px;">${f.name}</h3><p style="margin:0;font-size:13px;color:#888;">微信号: ${f.id}</p>${f.signature ? `<p style="margin:2px 0 0;font-size:13px;color:#888;">${f.signature}</p>` : ''}${f.persona ? `<p style="margin:4px 0 0;font-size:12px;color:#aaa;">${f.persona.substring(0, 50)}</p>` : ''}</div>
            </div>
            <button class="ws-full-btn ws-btn-green" onclick="WS.openChat('${f.id}',false)">发消息</button>
            <button class="ws-full-btn" style="background:#576B95;color:white;" onclick="WS.editFriend('${f.id}')">修改信息</button>
            <button class="ws-full-btn" style="background:#FA5151;color:white;" onclick="WS.deleteFriend('${f.id}')">删除好友</button>
        </div>`;
    }

    pgPersona() {
        return `${this.statusBar()}${this.navbar('个人人设', true, '<button onclick="WS.savePersona()" class="ws-btn-green">保存</button>')}
        <div class="ws-screen-body" style="background:white;padding:16px;">
            <label class="ws-label">昵称</label><input class="ws-input" id="ws-p-name" value="${state.settings.playerName}"/>
            <label class="ws-label">头像链接</label><input class="ws-input" id="ws-p-avatar" value="${state.settings.playerAvatar}"/>
            <button class="ws-full-btn" style="background:#f0f0f0;color:#333;margin:4px 0 12px;" onclick="WS.uploadFile('image/*',function(d){document.getElementById('ws-p-avatar').value=d;})">上传本地头像</button>
            <label class="ws-label">微信号</label><input class="ws-input" id="ws-p-wxid" value="${state.settings.playerId}"/>
            <label class="ws-label">个性签名</label><input class="ws-input" id="ws-p-sig" value="${state.settings.playerSignature}"/>
            <label class="ws-label">人设描述(AI参考)</label><textarea class="ws-input" id="ws-p-persona" style="min-height:100px;resize:vertical;">${state.settings.playerPersona}</textarea>
        </div>`;
    }

    // ================================================================
    //  功能方法
    // ================================================================

    // -- 聊天 --
    openChat(id, isGroup) { this.chatId = id; this.chatIsGroup = isGroup; this.nav('chat'); }
    onInput(el) {
        const btn = document.getElementById('ws-send-btn');
        btn.style.display = el.value.trim() ? 'block' : 'none';
        el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 80) + 'px';
    }
    sendMsg() {
        const inp = document.getElementById('ws-input'); const txt = inp?.value?.trim(); if (!txt) return;
        state.addMessage(this.chatId, { type: 'text', content: txt, sender: state.settings.playerName });
        inp.value = ''; inp.style.height = 'auto'; document.getElementById('ws-send-btn').style.display = 'none';
        state.pendingMessages++; this.render();
    }
    toggleMore() { const p = document.getElementById('ws-more-panel'); p.classList.toggle('show'); }
    searchChats(q) { document.querySelectorAll('#ws-chat-items .ws-chat-item').forEach(el => { el.style.display = el.textContent.includes(q) ? 'flex' : 'none'; }); }

    sendPhoto() {
        this.modal('发送照片', `
            <input class="ws-input" id="ws-photo-url" placeholder="图片链接"/>
            <button class="ws-full-btn" style="background:#f0f0f0;color:#333;margin-top:8px;" onclick="WS.uploadFile('image/*,image/gif',function(d){document.getElementById('ws-photo-url').value=d;})">上传本地图片</button>
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '发送', action: 'WS.doSendPhoto()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doSendPhoto() {
        const url = document.getElementById('ws-photo-url')?.value?.trim(); if (!url) { this.toast('请选择图片'); return; }
        state.addMessage(this.chatId, { type: 'image', url, sender: state.settings.playerName });
        state.pendingMessages++; this.closeModal(); this.render();
    }
    sendVideoDialog() {
        this.modal('发送视频', `
            <input class="ws-input" id="ws-video-url" placeholder="视频链接"/>
            <button class="ws-full-btn" style="background:#f0f0f0;color:#333;margin-top:8px;" onclick="WS.uploadFile('video/*',function(d){document.getElementById('ws-video-url').value=d;})">上传本地视频</button>
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '发送', action: 'WS.doSendVideo()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doSendVideo() {
        const url = document.getElementById('ws-video-url')?.value?.trim(); if (!url) return;
        state.addMessage(this.chatId, { type: 'video', url, sender: state.settings.playerName });
        state.pendingMessages++; this.closeModal(); this.render();
    }

    sendRedPacketDialog() {
        const isG = this.chatIsGroup;
        this.modal('发红包', `
            <input class="ws-input" id="ws-rp-amt" type="number" placeholder="金额" value="6.66" step="0.01"/>
            <input class="ws-input" id="ws-rp-greet" placeholder="祝福语" value="恭喜发财，大吉大利"/>
            ${isG ? '<select class="ws-input" id="ws-rp-type"><option value="normal">普通红包</option><option value="lucky">拼手气红包</option></select><input class="ws-input" id="ws-rp-count" type="number" value="5" placeholder="个数"/>' : ''}
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '塞钱进红包', action: 'WS.doSendRP()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doSendRP() {
        const amt = parseFloat(document.getElementById('ws-rp-amt')?.value) || 6.66;
        const greet = document.getElementById('ws-rp-greet')?.value || '恭喜发财';
        if (amt > state.wallet) { this.toast('余额不足'); return; }
        state.wallet = state.wallet - amt;
        const rpType = document.getElementById('ws-rp-type')?.value || 'normal';
        const rpCount = parseInt(document.getElementById('ws-rp-count')?.value) || 5;
        state.addMessage(this.chatId, { type: 'redpacket', sender: state.settings.playerName, greeting: greet, amount: amt, opened: false, rpType, rpCount, isGroupRp: this.chatIsGroup });
        state.pendingMessages++; this.closeModal(); this.render();
    }

    openRedPacket(msgId) {
        const h = state.getChatHistory(this.chatId);
        const msg = h.find(m => m.id === msgId);
        if (!msg) return;
        let rec = state.getRedpacketRecord(msgId);
        if (rec) {
            // 已领取，显示详情
            this.showRPDetail(msg, rec);
            return;
        }
        // 领取
        if (this.chatIsGroup && msg.rpType === 'lucky') {
            rec = this.generateLuckyRP(msg);
        } else {
            rec = { type: 'normal', amount: msg.amount, receiver: state.settings.playerName };
            if (msg.sender !== state.settings.playerName) state.wallet = state.wallet + msg.amount;
        }
        state.setRedpacketRecord(msgId, rec);
        this.showRPDetail(msg, rec);
    }

    generateLuckyRP(msg) {
        const group = state.getGroup(this.chatId);
        const members = group?.members?.map(m => m.name) || [state.settings.playerName];
        const count = Math.min(msg.rpCount || 5, members.length);
        const total = msg.amount;
        let amounts = []; let remaining = total;
        for (let i = 0; i < count - 1; i++) {
            const max = remaining / (count - i) * 2;
            const a = Math.max(0.01, Math.round(Math.random() * max * 100) / 100);
            amounts.push(a); remaining -= a;
        }
        amounts.push(Math.round(Math.max(0.01, remaining) * 100) / 100);
        const shuffled = [...members].sort(() => Math.random() - 0.5).slice(0, count);
        const results = shuffled.map((name, i) => ({ name, amount: amounts[i] }));
        const best = results.reduce((a, b) => a.amount > b.amount ? a : b);
        const myR = results.find(r => r.name === state.settings.playerName);
        if (myR) state.wallet = state.wallet + myR.amount;
        return { type: 'lucky', results, best: best.name, total };
    }

    showRPDetail(msg, rec) {
        let body;
        if (rec.type === 'lucky') {
            body = `<div style="text-align:center;"><div style="font-size:14px;color:#888;">${msg.sender}的拼手气红包</div>
                <div style="margin:12px 0;"><div style="font-size:12px;color:#888;">🏆 手气最佳</div><div style="font-size:20px;font-weight:700;color:#FA9D3B;">${rec.best}</div></div>
                <div style="border-top:1px solid #eee;padding-top:8px;text-align:left;">${rec.results.map(r => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;"><span>${r.name}${r.name === rec.best ? ' 🏆' : ''}</span><span style="color:#FA9D3B;font-weight:600;">¥${r.amount.toFixed(2)}</span></div>`).join('')}</div></div>`;
        } else {
            body = `<div style="text-align:center;"><div style="font-size:14px;color:#888;">${msg.sender}的红包</div><div style="font-size:14px;margin:8px 0;">${msg.greeting}</div><div style="font-size:32px;font-weight:700;color:#FA9D3B;">¥${rec.amount.toFixed(2)}</div></div>`;
        }
        this.modal('红包详情', body, [{ label: '关闭', action: 'WS.closeModal();WS.render();' }]);
    }

    sendGiftDialog() {
        const gifts = [['🌹', '玫瑰花', 5.20], ['💍', '钻戒', 520], ['🧸', '泰迪熊', 66], ['🎂', '蛋糕', 99], ['🍫', '巧克力', 13.14], ['⌚', '手表', 999], ['🚗', '跑车', 8888], ['💐', '花束', 52], ['🎮', '游戏机', 299]];
        this.modal('送礼物', `
            <div style="max-height:200px;overflow-y:auto;">${gifts.map(([e, n, p]) => `<div style="display:flex;align-items:center;padding:8px 0;cursor:pointer;border-bottom:1px solid #f0f0f0;" onclick="WS.doSendGift('${e}','${n}',${p})"><span style="font-size:24px;margin-right:8px;">${e}</span><span style="flex:1;font-size:14px;">${n}</span><span style="color:#FA5151;font-weight:600;">¥${p}</span></div>`).join('')}</div>
            <div style="margin-top:10px;border-top:1px solid #eee;padding-top:10px;"><input class="ws-input" id="ws-gift-name" placeholder="自定义名称"/><input class="ws-input" id="ws-gift-price" type="number" placeholder="金额"/><input class="ws-input" id="ws-gift-emoji" placeholder="emoji"/></div>
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '自定义发送', action: 'WS.doSendCustomGift()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doSendGift(emoji, name, price) {
        if (price > state.wallet) { this.toast('余额不足'); return; }
        state.wallet = state.wallet - price;
        state.addMessage(this.chatId, { type: 'gift', emoji, giftName: name, content: `送出了${name}`, sender: state.settings.playerName, price });
        state.pendingMessages++; this.closeModal(); this.render();
    }
    doSendCustomGift() {
        const n = document.getElementById('ws-gift-name')?.value || '礼物';
        const p = parseFloat(document.getElementById('ws-gift-price')?.value) || 1;
        const e = document.getElementById('ws-gift-emoji')?.value || '🎁';
        this.doSendGift(e, n, p);
    }

    doPat() {
        if (!this.chatIsGroup) {
            const f = state.getFriend(this.chatId);
            if (f) { state.addMessage(this.chatId, { type: 'pat', sender: state.settings.playerName, target: f.name }); this.render(); }
            return;
        }
        const g = state.getGroup(this.chatId); if (!g) return;
        const ms = g.members.filter(m => m.name !== state.settings.playerName);
        this.modal('拍一拍', `<div style="max-height:250px;overflow-y:auto;">${ms.map(m => `<div class="ws-sel-item" onclick="WS.confirmPat('${escA(m.name)}')"><img src="${m.avatar || defAvatar(m.name)}" onerror="this.src='${defAvatar(m.name)}'" class="ws-sel-av"/><span>${m.name}</span></div>`).join('')}</div>`, [{ label: '取消', action: 'WS.closeModal()' }]);
    }
    confirmPat(name) { state.addMessage(this.chatId, { type: 'pat', sender: state.settings.playerName, target: name }); this.closeModal(); this.render(); }

    atSomeone() {
        const g = state.getGroup(this.chatId); if (!g) return;
        const ms = g.members.filter(m => m.name !== state.settings.playerName);
        this.modal('@某人', `<div style="max-height:250px;overflow-y:auto;">${ms.map(m => `<div class="ws-sel-item" onclick="WS.insertAt('${escA(m.name)}')"><img src="${m.avatar || defAvatar(m.name)}" onerror="this.src='${defAvatar(m.name)}'" class="ws-sel-av"/><span>${m.name}</span></div>`).join('')}</div>`, [{ label: '取消', action: 'WS.closeModal()' }]);
    }
    insertAt(name) { const inp = document.getElementById('ws-input'); if (inp) { inp.value += `@${name} `; inp.focus(); } this.closeModal(); }

    sendFromBackpack() {
        const items = state.settings.backpack; if (items.length === 0) { this.toast('背包为空'); return; }
        this.modal('送出物品', `<div style="max-height:250px;overflow-y:auto;">${items.map(i => `<div class="ws-sel-item" onclick="WS.doSendBackpackItem('${escA(i.name)}')"><span style="font-size:24px;width:36px;text-align:center;">${i.emoji || '📦'}</span><span>${i.name} (×${i.count})</span></div>`).join('')}</div>`, [{ label: '取消', action: 'WS.closeModal()' }]);
    }
    doSendBackpackItem(name) {
        const item = state.settings.backpack.find(i => i.name === name); if (!item) return;
        state.addMessage(this.chatId, { type: 'gift', emoji: item.emoji || '📦', giftName: item.name, content: `从背包送出了${item.name}`, sender: state.settings.playerName });
        state.removeFromBackpack(name); state.pendingMessages++; this.closeModal(); this.render();
    }

    viewImage(url) {
        const o = document.createElement('div'); o.className = 'ws-img-viewer'; o.onclick = () => o.remove();
        o.innerHTML = `<img src="${url}"/>`; document.getElementById('ws-screen')?.appendChild(o);
    }
    playVideo(url) {
        const o = document.createElement('div'); o.className = 'ws-vid-viewer';
        o.innerHTML = `<video src="${url}" controls autoplay></video><button onclick="this.parentElement.remove()" style="position:absolute;top:10px;right:10px;background:rgba(255,255,255,0.3);border:none;color:white;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:16px;">✕</button>`;
        document.getElementById('ws-screen')?.appendChild(o);
    }

    chatMenu() {
        this.modal('', `
            <div class="ws-sel-item" onclick="WS.clearChatHistory()"><span>🗑️</span><span>清空聊天记录</span></div>
            ${this.chatIsGroup ? `<div class="ws-sel-item" onclick="WS.viewGroupMembers()"><span>👥</span><span>群成员</span></div>` : `<div class="ws-sel-item" onclick="WS.closeModal();WS.viewContactProfile('${this.chatId}')"><span>👤</span><span>查看资料</span></div>`}
        `, [{ label: '关闭', action: 'WS.closeModal()' }]);
    }
    clearChatHistory() { state.settings.chatHistories[this.chatId] = []; state.save(); this.closeModal(); this.render(); }
    viewGroupMembers() {
        const g = state.getGroup(this.chatId); if (!g) return; this.closeModal();
        this.modal(`群成员 (${g.members.length})`, `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">${g.members.map(m => `<div style="text-align:center;"><img src="${m.avatar || defAvatar(m.name)}" onerror="this.src='${defAvatar(m.name)}'" style="width:44px;height:44px;border-radius:6px;object-fit:cover;"/><div style="font-size:10px;color:#888;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.name}</div></div>`).join('')}</div>`, [{ label: '关闭', action: 'WS.closeModal()' }]);
    }

    // -- 好友管理 --
    addFriendDialog() {
        this.modal('添加好友', `
            <input class="ws-input" id="ws-af-name" placeholder="好友昵称"/>
            <input class="ws-input" id="ws-af-avatar" placeholder="头像链接(可选，留空自动生成)"/>
            <button class="ws-full-btn" style="background:#f0f0f0;color:#333;" onclick="WS.uploadFile('image/*',function(d){document.getElementById('ws-af-avatar').value=d;})">上传头像</button>
            <div style="margin-top:8px;padding:8px;background:#FFF7E6;border-radius:4px;font-size:12px;color:#FA9D3B;">💡 会自动从当前角色的世界书读取信息，并调用API生成详细资料</div>
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '添加', action: 'WS.doAddFriend()', style: 'color:#07C160;font-weight:600;' }]);
    }

    async doAddFriend() {
        const name = document.getElementById('ws-af-name')?.value?.trim();
        const avatarInput = document.getElementById('ws-af-avatar')?.value?.trim();
        if (!name) { this.toast('请输入昵称'); return; }
        if (state.settings.friends.find(f => f.name === name)) { this.toast('好友已存在'); return; }

        this.closeModal();
        this.toast('正在读取世界书并生成资料...');

        let avatar = avatarInput || '';
        let persona = '', chatStyle = '', signature = '', relation = '';

        // 1. 先从世界书读取
        const worldData = await WorldBookReader.getCharacterData(name);
        if (worldData) {
            if (worldData.头像 && !avatar) avatar = worldData.头像;
            if (worldData.人设) persona = worldData.人设;
            if (worldData.聊天风格) chatStyle = worldData.聊天风格;
            if (worldData.签名) signature = worldData.签名;
        }

        // 2. 调用API补充/生成完整资料
        try {
            const generated = await WeChatAPI.generateFriendInfo(name);
            if (generated) {
                if (!avatar && generated.avatar && !generated.avatar.includes('描述')) avatar = generated.avatar;
                if (!persona && generated.persona) persona = generated.persona;
                if (!chatStyle && generated.chatStyle) chatStyle = generated.chatStyle;
                if (!signature && generated.signature) signature = generated.signature;
                if (generated.relation) relation = generated.relation;
            }
        } catch (e) { console.warn('API生成好友信息失败', e); }

        const friendId = 'f_' + name.replace(/\s/g, '_') + '_' + Date.now();
        state.addFriend({
            id: friendId, name, avatar, persona, chatStyle, signature, relation, addedAt: Date.now()
        });

        this.toast(`已添加"${name}"`);
        this.render();
    }

    viewContactProfile(id) { this.contactId = id; this.nav('profile'); }
    viewProfile(name) {
        if (name === state.settings.playerName) { this.nav('persona'); return; }
        const f = state.settings.friends.find(x => x.name === name);
        if (f) this.viewContactProfile(f.id);
    }

    deleteFriend(id) {
        const f = state.getFriend(id);
        this.modal('删除好友', `<div style="text-align:center;">确定删除"${f?.name}"？<br><span style="color:#999;font-size:13px;">聊天记录也会删除</span></div>`,
            [{ label: '取消', action: 'WS.closeModal()' }, { label: '删除', action: `WS.confirmDeleteFriend('${id}')`, style: 'color:#FA5151;font-weight:600;' }]);
    }
    confirmDeleteFriend(id) { state.removeFriend(id); this.closeModal(); this.toast('已删除'); this.tab('contacts'); }

    editFriend(id) {
        const f = state.getFriend(id); if (!f) return;
        this.modal('修改好友', `
            <label class="ws-label">昵称</label><input class="ws-input" id="ws-ef-name" value="${f.name}"/>
            <label class="ws-label">头像链接</label><input class="ws-input" id="ws-ef-avatar" value="${f.avatar || ''}"/>
            <button class="ws-full-btn" style="background:#f0f0f0;color:#333;margin-bottom:8px;" onclick="WS.uploadFile('image/*',function(d){document.getElementById('ws-ef-avatar').value=d;})">上传头像</button>
            <label class="ws-label">人设</label><textarea class="ws-input" id="ws-ef-persona" style="min-height:50px;resize:vertical;">${f.persona || ''}</textarea>
            <label class="ws-label">聊天风格</label><input class="ws-input" id="ws-ef-style" value="${f.chatStyle || ''}"/>
            <label class="ws-label">签名</label><input class="ws-input" id="ws-ef-sig" value="${f.signature || ''}"/>
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '保存', action: `WS.doEditFriend('${id}')`, style: 'color:#07C160;font-weight:600;' }]);
    }
    doEditFriend(id) {
        const f = state.getFriend(id); if (!f) return;
        f.name = document.getElementById('ws-ef-name')?.value?.trim() || f.name;
        f.avatar = document.getElementById('ws-ef-avatar')?.value?.trim() || f.avatar;
        f.persona = document.getElementById('ws-ef-persona')?.value?.trim() || '';
        f.chatStyle = document.getElementById('ws-ef-style')?.value?.trim() || '';
        f.signature = document.getElementById('ws-ef-sig')?.value?.trim() || '';
        state.save(); this.closeModal(); this.render(); this.toast('已保存');
    }

    changeFriendAvatar(id) {
        this.modal('修改头像', `
            <input class="ws-input" id="ws-cfa-url" placeholder="头像链接"/>
            <button class="ws-full-btn" style="background:#f0f0f0;color:#333;" onclick="WS.uploadFile('image/*',function(d){document.getElementById('ws-cfa-url').value=d;})">上传本地图片</button>
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '确定', action: `WS.doChangeFriendAv('${id}')`, style: 'color:#07C160;font-weight:600;' }]);
    }
    doChangeFriendAv(id) {
        const f = state.getFriend(id); if (!f) return;
        const url = document.getElementById('ws-cfa-url')?.value?.trim(); if (url) { f.avatar = url; state.save(); }
        this.closeModal(); this.render();
    }

    showAddMenu() {
        this.modal('', `
            <div class="ws-sel-item" onclick="WS.closeModal();WS.addFriendDialog();"><span>👤</span><span>添加好友</span></div>
            <div class="ws-sel-item" onclick="WS.closeModal();WS.createGroupDialog();"><span>👥</span><span>创建群聊</span></div>
        `, [{ label: '关闭', action: 'WS.closeModal()' }]);
    }

    showGroupList() {
        const gs = state.settings.groups;
        this.modal('群聊', `
            ${gs.map(g => `<div class="ws-sel-item" onclick="WS.closeModal();WS.openChat('${g.id}',true);"><img src="${g.avatar || defAvatar(g.name)}" class="ws-sel-av"/><span>${g.name} (${g.members?.length || 0}人)</span></div>`).join('')}
            ${gs.length === 0 ? '<div class="ws-empty">暂无群聊</div>' : ''}
            <button class="ws-full-btn ws-btn-green" style="margin-top:10px;" onclick="WS.closeModal();WS.createGroupDialog();">创建群聊</button>
        `, [{ label: '关闭', action: 'WS.closeModal()' }]);
    }

    createGroupDialog() {
        const fs = state.settings.friends;
        this.modal('创建群聊', `
            <input class="ws-input" id="ws-gname" placeholder="群名称"/>
            <div style="font-size:13px;color:#888;margin-bottom:6px;">选择群成员：</div>
            <div style="max-height:200px;overflow-y:auto;">${fs.map(f => `<label class="ws-sel-item" style="cursor:pointer;"><input type="checkbox" class="ws-gm-check" value="${f.id}" data-name="${f.name}" data-avatar="${f.avatar || ''}" style="margin-right:8px;"/><img src="${f.avatar || defAvatar(f.name)}" class="ws-sel-av"/><span>${f.name}</span></label>`).join('')}${fs.length === 0 ? '<div class="ws-empty">先添加好友</div>' : ''}</div>
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '创建', action: 'WS.doCreateGroup()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doCreateGroup() {
        const name = document.getElementById('ws-gname')?.value?.trim(); if (!name) { this.toast('输入群名'); return; }
        const checks = document.querySelectorAll('.ws-gm-check:checked');
        const members = [{ id: state.settings.playerId, name: state.settings.playerName, avatar: state.settings.playerAvatar }];
        checks.forEach(cb => { const f = state.getFriend(cb.value); if (f) members.push({ id: f.id, name: f.name, avatar: f.avatar }); });
        if (members.length < 2) { this.toast('至少选1个好友'); return; }
        const gid = 'g_' + Date.now();
        state.settings.groups.push({ id: gid, name, avatar: '', members, createdAt: Date.now() });
        state.addMessage(gid, { type: 'system', content: `${state.settings.playerName} 创建了群聊"${name}"`, sender: '系统' });
        state.save(); this.closeModal(); this.openChat(gid, true);
    }

    // -- 我的 --
    changeMyAvatar() {
        this.modal('修改头像', `
            <input class="ws-input" id="ws-myav-url" value="${state.settings.playerAvatar}" placeholder="头像链接"/>
            <button class="ws-full-btn" style="background:#f0f0f0;color:#333;" onclick="WS.uploadFile('image/*',function(d){document.getElementById('ws-myav-url').value=d;})">上传本地图片</button>
        `, [{ label: '取消', action: 'WS.closeModal()' }, { label: '确定', action: 'WS.doChangeMyAv()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doChangeMyAv() {
        const url = document.getElementById('ws-myav-url')?.value?.trim();
        if (url) { state.settings.playerAvatar = url; state.save(); }
        this.closeModal(); this.render();
    }

    savePersona() {
        state.settings.playerName = document.getElementById('ws-p-name')?.value?.trim() || '我';
        state.settings.playerAvatar = document.getElementById('ws-p-avatar')?.value?.trim() || '';
        state.settings.playerId = document.getElementById('ws-p-wxid')?.value?.trim() || 'wxid_player';
        state.settings.playerSignature = document.getElementById('ws-p-sig')?.value?.trim() || '';
        state.settings.playerPersona = document.getElementById('ws-p-persona')?.value?.trim() || '';
        state.save(); this.toast('已保存'); this.goBack();
    }

    // -- 钱包 --
    walletRecharge() {
        this.modal('充值', '<input class="ws-input" id="ws-rc-amt" type="number" value="100" placeholder="金额"/>', [{ label: '取消', action: 'WS.closeModal()' }, { label: '充值', action: 'WS.doRecharge()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doRecharge() { const a = parseFloat(document.getElementById('ws-rc-amt')?.value) || 0; if (a <= 0) return; state.wallet = state.wallet + a; this.closeModal(); this.render(); this.toast(`+¥${a.toFixed(2)}`); }
    walletTransfer() {
        const fs = state.settings.friends;
        this.modal('转账', `<select class="ws-input" id="ws-tf-target">${fs.map(f => `<option value="${f.id}">${f.name}</option>`).join('')}</select><input class="ws-input" id="ws-tf-amt" type="number" placeholder="金额"/>`,
            [{ label: '取消', action: 'WS.closeModal()' }, { label: '转账', action: 'WS.doTransfer()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doTransfer() {
        const tid = document.getElementById('ws-tf-target')?.value; const a = parseFloat(document.getElementById('ws-tf-amt')?.value) || 0;
        if (a <= 0 || a > state.wallet) { this.toast(a <= 0 ? '输入金额' : '余额不足'); return; }
        const f = state.getFriend(tid); state.wallet = state.wallet - a;
        state.addMessage(tid, { type: 'system', content: `你向${f?.name || ''}转账了¥${a.toFixed(2)}`, sender: '系统' });
        this.closeModal(); this.render(); this.toast(`已转账¥${a.toFixed(2)}`);
    }

    // -- 背包 --
    useItem(name) {
        const item = state.settings.backpack.find(i => i.name === name); if (!item) return;
        const fs = state.settings.friends;
        this.modal(item.name, `<div style="text-align:center;margin-bottom:10px;"><span style="font-size:48px;">${item.emoji || '📦'}</span><div style="font-size:16px;font-weight:600;margin-top:4px;">${item.name} ×${item.count}</div></div>
            <div style="font-size:14px;color:#666;margin-bottom:6px;">送给好友：</div>
            <div style="max-height:200px;overflow-y:auto;">${fs.map(f => `<div class="ws-sel-item" onclick="WS.giftToFriend('${f.id}','${escA(name)}')"><img src="${f.avatar || defAvatar(f.name)}" class="ws-sel-av"/><span>${f.name}</span></div>`).join('')}</div>`,
            [{ label: '关闭', action: 'WS.closeModal()' }, { label: '丢弃', action: `WS.discardItem('${escA(name)}')`, style: 'color:#FA5151;' }]);
    }
    giftToFriend(fid, name) {
        const item = state.settings.backpack.find(i => i.name === name); const f = state.getFriend(fid);
        if (!item || !f) return;
        state.addMessage(fid, { type: 'gift', emoji: item.emoji || '📦', giftName: item.name, content: `送出了${item.name}`, sender: state.settings.playerName });
        state.removeFromBackpack(name); state.pendingMessages++; this.closeModal(); this.toast(`已送给${f.name}`); this.render();
    }
    discardItem(name) { state.removeFromBackpack(name); this.closeModal(); this.render(); }

    // -- 朋友圈 --
    addMomentImg() {
        const urlInput = document.getElementById('ws-moment-img-url');
        const url = urlInput?.value?.trim();
        if (url) { this.momentImages.push(url); urlInput.value = ''; this.render(); }
        else { this.uploadMultiFiles('image/*', (d) => { this.momentImages.push(d); this.render(); }); }
    }

    async publishMoment() {
        const text = document.getElementById('ws-moment-text')?.value?.trim();
        if (!text) { this.toast('请输入内容'); return; }
        const m = { id: 'mo_' + Date.now(), author: state.settings.playerName, avatar: state.settings.playerAvatar, text, images: [...this.momentImages], timestamp: Date.now(), likes: [], comments: [] };
        state.settings.moments.push(m); state.save();
        this.momentImages = [];
        this.toast('已发布，点击生成回复按钮获取互动');
        state.pendingMessages++;
        this.goBack();
    }

    likeMoment(id) {
        const m = state.settings.moments.find(x => x.id === id); if (!m) return;
        const pn = state.settings.playerName;
        if (m.likes?.includes(pn)) m.likes = m.likes.filter(n => n !== pn); else { if (!m.likes) m.likes = []; m.likes.push(pn); }
        state.save(); this.render();
    }

    // -- 公众号 --
    async searchOA() {
        const q = document.getElementById('ws-oa-search')?.value?.trim(); if (!q) return;
        this.toast('搜索中...');
        const results = await WeChatAPI.generateOA(q);
        const container = document.getElementById('ws-oa-results');
        if (container) {
            container.innerHTML = `<div class="ws-section-hd">搜索结果</div>${results.map(oa => `<div class="ws-contact-item" onclick="WS.openOA('${escA(oa.name)}')"><div style="width:40px;height:40px;border-radius:50%;background:#07C160;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">${oa.avatar || '📰'}</div><span>${oa.name}<br><small style="color:#888;">${oa.desc || ''}</small></span></div>`).join('')}`;
        }
    }
    openOA(name) { this.oaName = name; this.oaArticles = []; this.nav('oa-detail'); }
    async pushArticles() {
        this.toast('获取文章中...');
        this.oaArticles = await WeChatAPI.generateArticles(this.oaName);
        this.render();
    }
    followOA() {
        if (!state.settings.followedOA) state.settings.followedOA = [];
        if (state.settings.followedOA.find(o => o.name === this.oaName)) { this.toast('已关注'); return; }
        state.settings.followedOA.push({ name: this.oaName, avatar: '📰' });
        state.save(); this.toast('已关注'); this.render();
    }
    readArticle(article) { this.currentArticle = article; this.nav('article'); }

    // -- 购物 --
    async openShop() {
        this.nav('shop');
        if (this.shopItems.length === 0) {
            this.shopItems = await WeChatAPI.generateShopItems();
            this.render();
        }
    }
    async searchShop() {
        const q = document.getElementById('ws-shop-search')?.value?.trim(); if (!q) return;
        this.toast('搜索中...');
        this.shopItems = await WeChatAPI.generateShopItems(q);
        this.render();
    }
    addToCart(name, price, emoji) {
        const cart = state.settings.shoppingCart;
        const e = cart.find(c => c.name === name);
        if (e) e.qty++; else cart.push({ name, price, emoji, qty: 1 });
        state.save(); this.render(); this.toast(`已加入购物车`);
    }
    cartQty(name, d) {
        const cart = state.settings.shoppingCart; const i = cart.find(c => c.name === name);
        if (i) { i.qty += d; if (i.qty <= 0) state.settings.shoppingCart = cart.filter(c => c.name !== name); }
        state.save(); this.render();
    }
    clearCart() { state.settings.shoppingCart = []; state.save(); this.render(); }
    toggleCartPanel() { const p = document.getElementById('ws-cart-panel'); if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
    checkout() {
        const cart = state.settings.shoppingCart; if (cart.length === 0) { this.toast('购物车是空的'); return; }
        const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
        if (total > state.wallet) { this.toast('余额不足'); return; }
        this.modal('确认结算', `${cart.map(c => `<div style="display:flex;justify-content:space-between;font-size:14px;padding:4px 0;"><span>${c.emoji} ${c.name} ×${c.qty}</span><span style="color:#FA5151">¥${(c.price * c.qty).toFixed(2)}</span></div>`).join('')}<div style="border-top:1px solid #eee;margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;font-weight:600;"><span>合计</span><span style="color:#FA5151;font-size:18px;">¥${total.toFixed(2)}</span></div><div style="font-size:12px;color:#888;margin-top:8px;">物品将放入背包</div>`,
            [{ label: '取消', action: 'WS.closeModal()' }, { label: '支付', action: 'WS.doCheckout()', style: 'color:#07C160;font-weight:600;' }]);
    }
    doCheckout() {
        const cart = state.settings.shoppingCart;
        const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
        state.wallet = state.wallet - total;
        cart.forEach(c => state.addToBackpack({ name: c.name, emoji: c.emoji, price: c.price, count: c.qty }));
        state.settings.shoppingCart = []; state.save();
        this.closeModal(); this.toast('购买成功！'); this.render();
    }

    // -- 论坛 --
    async openForum() {
        this.nav('forum');
        if (this.forumPosts.length === 0) { await this.refreshForum(); }
    }
    async refreshForum() {
        this.toast('加载中...'); this.forumPosts = await WeChatAPI.generateForumPosts(); this.render();
    }
    async searchForum() {
        const q = document.getElementById('ws-forum-search')?.value?.trim(); if (!q) return;
        this.toast('搜索中...'); this.forumPosts = await WeChatAPI.generateForumPosts(q); this.render();
    }
    openForumPost(id) {
        const p = state.settings.forumPostDetails[id] || this.forumPosts.find(x => x.id === id);
        if (p) { this.currentForumPost = p; this.nav('forum-post'); }
    }

    // -- 设置 --
    openSettings() {
        const panel = document.getElementById('ws-settings-panel');
        const models = state.settings.availableModels;
        panel.innerHTML = `<div class="ws-settings-hd"><span>⚙️ 插件设置</span><button onclick="WS.closeSettingsPanel()">✕</button></div>
        <div class="ws-settings-bd">
            <h4>API 配置</h4>
            <label class="ws-label">API 地址</label><input class="ws-input" id="ws-s-ep" value="${state.settings.apiEndpoint}" placeholder="https://api.xxx.com/v1"/>
            <label class="ws-label">API Key</label><input class="ws-input" id="ws-s-key" type="password" value="${state.settings.apiKey}"/>
            <button class="ws-full-btn ws-btn-green" onclick="WS.doFetchModels()">拉取模型列表</button>
            <label class="ws-label">选择模型</label>
            <select class="ws-input" id="ws-s-model"><option value="">-- 请选择 --</option>${models.map(m => `<option value="${m.id}" ${m.id === state.settings.modelId ? 'selected' : ''}>${m.name}</option>`).join('')}</select>
            <label class="ws-label">手动输入模型ID</label><input class="ws-input" id="ws-s-model-custom" value="${state.settings.modelId}"/>
            <h4>生成参数</h4>
            <label class="ws-label">最大Token</label><input class="ws-input" id="ws-s-tokens" type="number" value="${state.settings.maxTokens}"/>
            <label class="ws-label">Temperature</label><input class="ws-input" id="ws-s-temp" type="number" step="0.05" value="${state.settings.temperature}"/>
            <h4>世界书说明</h4>
            <div style="font-size:12px;color:#888;padding:8px;background:#f7f7f7;border-radius:6px;">插件只读取当前酒馆角色关联的世界书。<br>条目格式：key=角色名<br>content含：头像、照片、视频、人设、聊天风格等字段</div>
            <h4>数据管理</h4>
            <button class="ws-full-btn" style="background:#f0f0f0;color:#333;" onclick="WS.exportData()">导出数据</button>
            <button class="ws-full-btn" style="background:#FA5151;color:white;margin-top:8px;" onclick="WS.resetData()">重置所有数据</button>
            <button class="ws-full-btn ws-btn-green" style="margin-top:16px;" onclick="WS.saveSettings()">保存设置</button>
        </div>`;
        panel.classList.add('show');
    }
    closeSettingsPanel() { document.getElementById('ws-settings-panel').classList.remove('show'); }
    async doFetchModels() {
        state.settings.apiEndpoint = document.getElementById('ws-s-ep')?.value?.trim() || '';
        state.settings.apiKey = document.getElementById('ws-s-key')?.value?.trim() || '';
        state.save(); this.toast('拉取中...');
        const models = await WeChatAPI.fetchModels();
        this.toast(models.length > 0 ? `获取到${models.length}个模型` : '拉取失败，检查配置');
        this.openSettings();
    }
    saveSettings() {
        state.settings.apiEndpoint = document.getElementById('ws-s-ep')?.value?.trim() || '';
        state.settings.apiKey = document.getElementById('ws-s-key')?.value?.trim() || '';
        state.settings.modelId = document.getElementById('ws-s-model-custom')?.value?.trim() || document.getElementById('ws-s-model')?.value || '';
        state.settings.maxTokens = parseInt(document.getElementById('ws-s-tokens')?.value) || 2048;
        state.settings.temperature = parseFloat(document.getElementById('ws-s-temp')?.value) || 0.85;
        state.save(); this.toast('已保存'); this.closeSettingsPanel();
    }
    exportData() {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(state.settings, null, 2)], { type: 'application/json' }));
        a.download = `wechatsim_${Date.now()}.json`; a.click();
    }
    resetData() {
        this.modal('重置', '<div style="text-align:center;color:#FA5151;">确定重置所有数据？不可撤销！</div>',
            [{ label: '取消', action: 'WS.closeModal()' }, { label: '重置', action: 'WS.doReset()', style: 'color:#FA5151;font-weight:600;' }]);
    }
    doReset() {
        Object.keys(defaultSettings).forEach(k => state.settings[k] = JSON.parse(JSON.stringify(defaultSettings[k])));
        state.save(); this.shopItems = []; this.forumPosts = []; this.closeModal(); this.closeSettingsPanel(); this.tab('chats'); this.toast('已重置');
    }
}

// ============ 初始化 ============
const app = new WeChatSimApp();
window.WS = app;
jQuery(async () => { try { await app.init(); console.log("WeChatSim v3.0 loaded"); } catch (e) { console.error("WeChatSim init error", e); } });
export { extensionName };
