// ============================================
// WeChatSim - SillyTavern 微信模拟插件
// 完整版主入口
// ============================================

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "WeChatSim";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ============================================
// 默认设置
// ============================================
const defaultSettings = {
    // API 配置
    apiEndpoint: "",
    apiKey: "",
    modelId: "",
    availableModels: [],
    maxTokens: 2048,
    temperature: 0.85,

    // 玩家信息
    playerName: "我",
    playerAvatar: "",
    playerPersona: "",
    playerId: "wxid_player",
    playerSignature: "这个人很懒，什么都没写",

    // 钱包
    walletBalance: 8888.88,

    // 背包
    backpack: [],

    // 好友列表
    friends: [],

    // 群聊列表
    groups: [],

    // 聊天记录
    chatHistories: {},

    // 朋友圈
    moments: [],

    // 公众号
    officialAccounts: [],

    // 购物车
    shoppingCart: [],

    // 论坛帖子
    forumPosts: [],

    // UI状态
    isOpen: false,
    currentPage: "chat-list",
    unreadCount: 0,

    // 世界书名称
    worldBookName: "WeChatSim",
};

// ============================================
// 全局状态管理
// ============================================
class WeChatState {
    constructor() {
        this.settings = {};
        this.currentChat = null;
        this.currentPage = "chat-list";
        this.pageStack = [];
        this.pendingMessages = 0;
        this.isGenerating = false;
        this.messageQueue = [];
    }

    init() {
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        this.settings = extension_settings[extensionName];
        Object.keys(defaultSettings).forEach(key => {
            if (this.settings[key] === undefined) {
                this.settings[key] = JSON.parse(JSON.stringify(defaultSettings[key]));
            }
        });
        this.save();
    }

    save() {
        saveSettingsDebounced();
    }

    get friends() { return this.settings.friends; }
    get groups() { return this.settings.groups; }
    get moments() { return this.settings.moments; }
    get backpack() { return this.settings.backpack; }
    get wallet() { return this.settings.walletBalance; }
    set wallet(val) { this.settings.walletBalance = val; this.save(); }

    getChatHistory(chatId) {
        if (!this.settings.chatHistories[chatId]) {
            this.settings.chatHistories[chatId] = [];
        }
        return this.settings.chatHistories[chatId];
    }

    addMessage(chatId, msg) {
        const history = this.getChatHistory(chatId);
        msg.id = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        msg.timestamp = Date.now();
        history.push(msg);
        this.save();
        return msg;
    }

    getFriend(id) {
        return this.settings.friends.find(f => f.id === id);
    }

    getGroup(id) {
        return this.settings.groups.find(g => g.id === id);
    }

    addFriend(friend) {
        if (!this.settings.friends.find(f => f.id === friend.id)) {
            this.settings.friends.push(friend);
            this.save();
        }
    }

    removeFriend(id) {
        this.settings.friends = this.settings.friends.filter(f => f.id !== id);
        delete this.settings.chatHistories[id];
        this.save();
    }

    addToBackpack(item) {
        const existing = this.settings.backpack.find(i => i.name === item.name);
        if (existing) {
            existing.count = (existing.count || 1) + (item.count || 1);
        } else {
            item.count = item.count || 1;
            this.settings.backpack.push(item);
        }
        this.save();
    }

    removeFromBackpack(itemName, count = 1) {
        const item = this.settings.backpack.find(i => i.name === itemName);
        if (item) {
            item.count -= count;
            if (item.count <= 0) {
                this.settings.backpack = this.settings.backpack.filter(i => i.name !== itemName);
            }
            this.save();
            return true;
        }
        return false;
    }
}

const state = new WeChatState();

// ============================================
// 世界书接口
// ============================================
class WorldBookReader {
    static async getEntries() {
        try {
            const context = getContext();
            if (context && context.extensionSettings) {
                // 尝试从世界书读取
                const worldInfo = context.worldInfo || [];
                return worldInfo;
            }
        } catch (e) {
            console.warn("WeChatSim: 无法读取世界书", e);
        }
        return [];
    }

    static async findEntry(keyword) {
        const entries = await this.getEntries();
        return entries.find(e =>
            e.key && e.key.some(k => k.toLowerCase().includes(keyword.toLowerCase()))
        );
    }

    static async getCharacterData(name) {
        const entry = await this.findEntry(name);
        if (entry && entry.content) {
            return this.parseCharacterData(entry.content);
        }
        return null;
    }

    static parseCharacterData(content) {
        const data = {};
        const avatarMatch = content.match(/头像[：:]\s*(.+)/);
        if (avatarMatch) data.avatar = avatarMatch[1].trim();

        const photoMatch = content.match(/照片[：:]\s*(.+)/);
        if (photoMatch) data.photos = photoMatch[1].trim().split(/[,，]/);

        const videoMatch = content.match(/视频[：:]\s*(.+)/);
        if (videoMatch) data.videos = videoMatch[1].trim().split(/[,，]/);

        const personaMatch = content.match(/人设[：:]\s*(.+)/);
        if (personaMatch) data.persona = personaMatch[1].trim();

        const styleMatch = content.match(/聊天风格[：:]\s*(.+)/);
        if (styleMatch) data.chatStyle = styleMatch[1].trim();

        return data;
    }

    static async getMediaUrl(characterName, mediaType) {
        const data = await this.getCharacterData(characterName);
        if (!data) return null;
        if (mediaType === 'photo' && data.photos && data.photos.length > 0) {
            return data.photos[Math.floor(Math.random() * data.photos.length)];
        }
        if (mediaType === 'video' && data.videos && data.videos.length > 0) {
            return data.videos[Math.floor(Math.random() * data.videos.length)];
        }
        if (mediaType === 'avatar') {
            return data.avatar || null;
        }
        return null;
    }
}

// ============================================
// API 接口
// ============================================
class WeChatAPI {
    static async fetchModels() {
        const endpoint = state.settings.apiEndpoint;
        const apiKey = state.settings.apiKey;
        if (!endpoint || !apiKey) return [];

        try {
            const response = await fetch(`${endpoint}/v1/models`, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            const data = await response.json();
            if (data.data) {
                state.settings.availableModels = data.data.map(m => ({
                    id: m.id,
                    name: m.id
                }));
                state.save();
                return state.settings.availableModels;
            }
        } catch (e) {
            console.error("WeChatSim: 拉取模型失败", e);
        }
        return [];
    }

    static async generateResponse(systemPrompt, messages, options = {}) {
        const endpoint = state.settings.apiEndpoint;
        const apiKey = state.settings.apiKey;
        const model = state.settings.modelId;

        if (!endpoint || !apiKey || !model) {
            return "请先在设置中配置API地址、密钥和模型。";
        }

        try {
            const body = {
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...messages
                ],
                max_tokens: options.maxTokens || state.settings.maxTokens,
                temperature: options.temperature || state.settings.temperature,
                stream: false
            };

            const response = await fetch(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            const data = await response.json();
            if (data.choices && data.choices[0]) {
                return data.choices[0].message.content;
            }
            return "生成回复失败";
        } catch (e) {
            console.error("WeChatSim: API调用失败", e);
            return "API调用出错：" + e.message;
        }
    }

    static buildChatPrompt(chatId, isGroup = false) {
        const history = state.getChatHistory(chatId);
        const recentMessages = history.slice(-30);
        const context = getContext();

        let charCard = "";
        let worldBookInfo = "";

        // 读取角色卡信息
        if (context && context.characters) {
            const char = context.characters[context.characterId];
            if (char) {
                charCard = char.description || "";
            }
        }

        // 获取群聊/私聊信息
        let chatInfo = "";
        if (isGroup) {
            const group = state.getGroup(chatId);
            if (group) {
                chatInfo = `当前是群聊"${group.name}"，群成员：${group.members.map(m => m.name).join('、')}`;
            }
        } else {
            const friend = state.getFriend(chatId);
            if (friend) {
                chatInfo = `当前是与"${friend.name}"的私聊`;
                if (friend.persona) chatInfo += `\n好友人设：${friend.persona}`;
            }
        }

        const systemPrompt = `你是一个微信聊天模拟器的AI。你需要扮演微信中的联系人进行回复。

角色设定：
${charCard}

${worldBookInfo}

${chatInfo}

玩家信息：
- 名字：${state.settings.playerName}
- 人设：${state.settings.playerPersona}

回复规则：
1. 模拟真实的微信聊天风格，使用口语化表达
2. 可以发送文字、表情、图片描述等
3. 回复要符合角色性格和世界书设定
4. 回复格式用JSON：
   - 单条消息：{"type":"text","content":"消息内容","sender":"发送者名字"}
   - 图片消息：{"type":"image","url":"图片URL或描述","sender":"发送者名字"}
   - 多条消息：[{"type":"text","content":"...","sender":"..."},...]
   - 拍一拍：{"type":"pat","sender":"发送者","target":"目标"}
   - 红包：{"type":"redpacket","sender":"发送者","greeting":"恭喜发财","amount":随机金额}
5. 群聊时可以有多人回复，不同sender
6. 参考角色卡和世界书中的聊天风格
7. 只输出JSON，不要其他内容`;

        const apiMessages = recentMessages.map(msg => ({
            role: msg.sender === state.settings.playerName ? "user" : "assistant",
            content: `[${msg.sender}]: ${msg.type === 'text' ? msg.content : `[${msg.type}]`}`
        }));

        return { systemPrompt, apiMessages };
    }

    static async generateChatReply(chatId, isGroup = false) {
        const { systemPrompt, apiMessages } = this.buildChatPrompt(chatId, isGroup);
        const raw = await this.generateResponse(systemPrompt, apiMessages);

        try {
            // 尝试解析JSON
            let cleaned = raw.trim();
            // 移除 markdown 代码块包裹
            cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
            const parsed = JSON.parse(cleaned);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            // 如果不是JSON，作为纯文本处理
            return [{
                type: "text",
                content: raw,
                sender: this.getDefaultSender(chatId, isGroup)
            }];
        }
    }

    static getDefaultSender(chatId, isGroup) {
        if (isGroup) {
            const group = state.getGroup(chatId);
            if (group && group.members.length > 0) {
                const nonPlayer = group.members.filter(m => m.name !== state.settings.playerName);
                return nonPlayer.length > 0 ? nonPlayer[Math.floor(Math.random() * nonPlayer.length)].name : group.members[0].name;
            }
            return "群友";
        }
        const friend = state.getFriend(chatId);
        return friend ? friend.name : "对方";
    }

    static async generateMomentComments(momentText) {
        const friends = state.settings.friends.slice(0, 10);
        const friendNames = friends.map(f => f.name).join('、');

        const prompt = `玩家"${state.settings.playerName}"发了一条朋友圈：
"${momentText}"

好友列表：${friendNames}

请生成朋友圈互动（点赞和评论），格式为JSON：
{
  "likes": ["点赞人名1", "点赞人名2"],
  "comments": [
    {"sender": "评论人名", "content": "评论内容"},
    {"sender": "评论人名", "content": "评论内容", "replyTo": "被回复人名(可选)"}
  ]
}
评论要自然真实，符合每个人的性格。只输出JSON。`;

        const raw = await this.generateResponse(prompt, []);
        try {
            let cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
            return JSON.parse(cleaned);
        } catch {
            return { likes: [friends[0]?.name || "好友"], comments: [{ sender: friends[0]?.name || "好友", content: "👍" }] };
        }
    }

    static async generateOfficialAccounts(query) {
        const prompt = `用户在微信搜索公众号："${query}"
请生成3-5个相关的公众号，格式为JSON数组：
[
  {"name":"公众号名称","desc":"简介","avatar":"头像描述(使用emoji代替)"}
]
只输出JSON。`;

        const raw = await this.generateResponse(prompt, []);
        try {
            let cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
            return JSON.parse(cleaned);
        } catch {
            return [{ name: query + "资讯", desc: "关注获取最新资讯", avatar: "📰" }];
        }
    }

    static async generateArticles(accountName) {
        const prompt = `公众号"${accountName}"推送了新文章。
请生成3篇文章，格式为JSON数组：
[
  {"title":"文章标题","summary":"摘要(30字内)","content":"完整文章内容(200-500字)","readCount":阅读数}
]
文章内容要有意义且完整。只输出JSON。`;

        const raw = await this.generateResponse(prompt, []);
        try {
            let cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
            return JSON.parse(cleaned);
        } catch {
            return [{ title: "最新文章", summary: "点击查看", content: "文章内容加载失败", readCount: 100 }];
        }
    }

    static async generateShopItems() {
        const context = getContext();
        let worldInfo = "";
        if (context && context.characters && context.characters[context.characterId]) {
            worldInfo = context.characters[context.characterId].description || "";
        }

        const prompt = `${worldInfo ? '参考设定：' + worldInfo.substring(0, 500) : ''}
请生成6-8个微信商城商品，格式为JSON数组：
[
  {"name":"商品名","price":价格数字,"desc":"商品描述","emoji":"代表emoji","category":"分类"}
]
商品要有趣味性，价格合理。只输出JSON。`;

        const raw = await this.generateResponse(prompt, []);
        try {
            let cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
            return JSON.parse(cleaned);
        } catch {
            return [
                { name: "神秘礼盒", price: 99, desc: "内含惊喜", emoji: "🎁", category: "礼物" },
                { name: "幸运符", price: 66, desc: "带来好运", emoji: "🍀", category: "道具" }
            ];
        }
    }

    static async generateForumPosts() {
        const context = getContext();
        let worldInfo = "";
        if (context && context.characters && context.characters[context.characterId]) {
            worldInfo = context.characters[context.characterId].description || "";
        }

        const friends = state.settings.friends.slice(0, 8);
        const friendNames = friends.map(f => f.name).join('、');

        const prompt = `${worldInfo ? '参考设定：' + worldInfo.substring(0, 500) : ''}
论坛用户包括：${friendNames || '路人甲、路人乙'}

请生成4-6条论坛帖子，格式为JSON数组：
[
  {"author":"发帖人","title":"帖子标题","content":"帖子内容(50-150字)","likes":点赞数,"comments":评论数,"time":"发帖时间如'2小时前'"}
]
帖子风格参考角色卡世界书设定。只输出JSON。`;

        const raw = await this.generateResponse(prompt, []);
        try {
            let cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
            return JSON.parse(cleaned);
        } catch {
            return [{ author: "系统", title: "欢迎来到论坛", content: "这里是论坛", likes: 0, comments: 0, time: "刚刚" }];
        }
    }
}

// ============================================
// SVG 图标库
// ============================================
const Icons = {
    wechat: `<svg viewBox="0 0 24 24"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 01.213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.328.328 0 00.167-.054l1.903-1.114a.864.864 0 01.717-.098 10.16 10.16 0 002.837.403c.276 0 .543-.027.811-.05a6.577 6.577 0 01-.253-1.82c0-3.697 3.37-6.694 7.527-6.694.259 0 .508.025.764.042C16.833 4.905 13.147 2.188 8.691 2.188zm-2.87 4.401a1.026 1.026 0 11-.001 2.052 1.026 1.026 0 010-2.052zm5.742 0a1.026 1.026 0 110 2.052 1.026 1.026 0 010-2.052zm4.198 2.908c-3.732 0-6.759 2.654-6.759 5.93 0 3.274 3.027 5.93 6.76 5.93.867 0 1.7-.143 2.47-.402a.73.73 0 01.604.083l1.61.943a.276.276 0 00.142.046c.134 0 .244-.111.244-.248 0-.06-.024-.12-.04-.18l-.33-1.252a.498.498 0 01.18-.56C20.88 18.682 21.9 16.906 21.9 15.43c.002-3.278-3.025-5.932-6.759-5.932h.001zm-2.926 3.28a.868.868 0 110 1.735.868.868 0 010-1.735zm5.088 0a.868.868 0 110 1.736.868.868 0 010-1.736z"/></svg>`,
    contacts: `<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
    discover: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`,
    me: `<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`,
    search: `<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`,
    back: `<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>`,
    more: `<svg viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>`,
    camera: `<svg viewBox="0 0 24 24"><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>`,
    image: `<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`,
    video: `<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`,
    emoji: `<svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>`,
    mic: `<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>`,
    redpacket: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`,
    gift: `<svg viewBox="0 0 24 24"><path d="M20 6h-2.18c.11-.31.18-.65.18-1 0-1.66-1.34-3-3-3-1.05 0-1.96.54-2.5 1.35l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 12 7.4l3.38 4.6L17 10.83 14.92 8H20v6z"/></svg>`,
    wallet: `<svg viewBox="0 0 24 24"><path d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
    shop: `<svg viewBox="0 0 24 24"><path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/></svg>`,
    forum: `<svg viewBox="0 0 24 24"><path d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`,
    send: `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
    like: `<svg viewBox="0 0 24 24"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-1.91l-.01-.01L23 10z"/></svg>`,
    comment: `<svg viewBox="0 0 24 24"><path d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18z"/></svg>`,
    close: `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
    article: `<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`,
    backpack: `<svg viewBox="0 0 24 24"><path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`,
    delete: `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="#FA5151"/></svg>`,
    edit: `<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`,
    addFriend: `<svg viewBox="0 0 24 24"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    moments_icon: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
    signal: `<svg viewBox="0 0 24 24"><path d="M2 22h20V2z" opacity="0.3"/><path d="M2 22h20V2zm18 0H4V4.02L20 20z"/></svg>`,
    wifi: `<svg viewBox="0 0 24 24"><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>`,
    battery: `<svg viewBox="0 0 24 24"><path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z"/></svg>`,
};

// ============================================
// UI 渲染引擎
// ============================================
class WeChatUI {
    constructor() {
        this.phone = null;
        this.screenContent = null;
    }

    // 获取当前时间字符串
    getTimeStr() {
        const now = new Date();
        return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    }

    // 格式化时间戳
    formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const now = new Date();
        const diff = now - d;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
        if (diff < 86400000) return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        return `${d.getMonth() + 1}/${d.getDate()}`;
    }

    // 默认头像
    defaultAvatar(name = '') {
        const colors = ['#07C160', '#FA5151', '#576B95', '#FF8800', '#C44AFF', '#00BFFF'];
        const color = colors[Math.abs(this.hashCode(name)) % colors.length];
        const initial = (name || '?')[0];
        return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="${color}" width="100" height="100" rx="8"/><text x="50" y="62" fill="white" font-size="45" font-family="Arial" text-anchor="middle" font-weight="bold">${initial}</text></svg>`)}`;
    }

    hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    // 显示Toast
    showToast(message) {
        const existing = this.phone.querySelector('.wechat-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'wechat-toast';
        toast.textContent = message;
        this.phone.querySelector('.wechat-screen').appendChild(toast);
        setTimeout(() => toast.remove(), 2200);
    }

    // 渲染状态栏
    renderStatusBar() {
        return `
            <div class="wechat-statusbar">
                <span class="time">${this.getTimeStr()}</span>
                <div class="status-icons">
                    ${Icons.wifi}
                    ${Icons.battery}
                </div>
            </div>`;
    }

    // 渲染导航栏
    renderNavbar(title, hasBack = false, actions = '') {
        return `
            <div class="wechat-navbar" style="position:relative;">
                ${hasBack ? `<button class="nav-back" onclick="wechatSim.goBack()">${Icons.back}</button>` : '<div></div>'}
                <div class="nav-title">${title}</div>
                <div class="nav-actions">${actions}</div>
            </div>`;
    }

    // 渲染底部Tab
    renderTabbar(activeTab = 'chats') {
        const tabs = [
            { id: 'chats', label: '微信', icon: Icons.wechat },
            { id: 'contacts', label: '通讯录', icon: Icons.contacts },
            { id: 'discover', label: '发现', icon: Icons.discover },
            { id: 'me', label: '我', icon: Icons.me }
        ];
        return `
            <div class="wechat-tabbar">
                ${tabs.map(t => `
                    <button class="wechat-tab ${activeTab === t.id ? 'active' : ''}" onclick="wechatSim.switchTab('${t.id}')">
                        ${t.icon}
                        <span>${t.label}</span>
                        ${t.id === 'chats' && state.settings.unreadCount > 0 ? `<span class="tab-badge">${state.settings.unreadCount}</span>` : ''}
                    </button>
                `).join('')}
            </div>`;
    }

    // ========== 主Tab页面渲染 ==========

    // 聊天列表
    renderChatList() {
        const allChats = [];

        // 收集所有有聊天记录的好友
        state.settings.friends.forEach(f => {
            const history = state.getChatHistory(f.id);
            const lastMsg = history[history.length - 1];
            if (lastMsg || true) { // 显示所有好友
                allChats.push({
                    id: f.id,
                    name: f.name,
                    avatar: f.avatar || this.defaultAvatar(f.name),
                    lastMsg: lastMsg ? (lastMsg.type === 'text' ? lastMsg.content : `[${lastMsg.type === 'image' ? '图片' : lastMsg.type === 'video' ? '视频' : lastMsg.type === 'redpacket' ? '红包' : lastMsg.type === 'gift' ? '礼物' : '消息'}]`) : '',
                    time: lastMsg ? this.formatTime(lastMsg.timestamp) : '',
                    isGroup: false,
                    timestamp: lastMsg ? lastMsg.timestamp : 0
                });
            }
        });

        // 收集所有群聊
        state.settings.groups.forEach(g => {
            const history = state.getChatHistory(g.id);
            const lastMsg = history[history.length - 1];
            allChats.push({
                id: g.id,
                name: g.name,
                avatar: g.avatar || this.defaultAvatar(g.name),
                lastMsg: lastMsg ? (lastMsg.sender ? `${lastMsg.sender}: ` : '') + (lastMsg.type === 'text' ? lastMsg.content : `[${lastMsg.type}]`) : '',
                time: lastMsg ? this.formatTime(lastMsg.timestamp) : '',
                isGroup: true,
                timestamp: lastMsg ? lastMsg.timestamp : 0
            });
        });

        // 按时间排序
        allChats.sort((a, b) => b.timestamp - a.timestamp);

        const addActions = `
            <button onclick="wechatSim.showAddMenu()" title="添加">${Icons.plus}</button>
        `;

        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('微信', false, addActions)}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-chat-list">
                    <div class="wechat-search-bar">
                        <input type="text" placeholder="搜索" oninput="wechatSim.searchChats(this.value)"/>
                    </div>
                    <div id="chat-list-items">
                        ${allChats.map(c => `
                            <div class="chat-list-item" onclick="wechatSim.openChat('${c.id}', ${c.isGroup})">
                                <img class="avatar" src="${c.avatar}" onerror="this.src='${this.defaultAvatar(c.name)}'" alt="${c.name}"/>
                                <div class="chat-info">
                                    <div class="chat-name">
                                        <span class="name-text">${c.name}</span>
                                        <span class="chat-time">${c.time}</span>
                                    </div>
                                    <div class="chat-preview">${this.escapeHtml(c.lastMsg).substring(0, 30)}</div>
                                </div>
                            </div>
                        `).join('')}
                        ${allChats.length === 0 ? '<div style="text-align:center;padding:40px;color:#999;">暂无聊天记录<br>点击右上角 + 添加好友</div>' : ''}
                    </div>
                </div>
            </div>
            ${this.renderTabbar('chats')}`;
    }

    // 聊天页面
    renderChatPage(chatId, isGroup = false) {
        const info = isGroup ? state.getGroup(chatId) : state.getFriend(chatId);
        if (!info) return this.renderChatList();

        const history = state.getChatHistory(chatId);
        const title = info.name + (isGroup ? ` (${info.members?.length || 0})` : '');

        const chatActions = `
            <button onclick="wechatSim.showChatMenu('${chatId}', ${isGroup})">${Icons.more}</button>
        `;

        const messagesHtml = history.map((msg, i) => {
            const isSelf = msg.sender === state.settings.playerName;
            const senderInfo = isGroup && !isSelf ? this.findSenderInfo(msg.sender, info) : null;
            const avatar = isSelf
                ? (state.settings.playerAvatar || this.defaultAvatar(state.settings.playerName))
                : (senderInfo?.avatar || info.avatar || this.defaultAvatar(msg.sender || info.name));

            // 时间标签
            let timeLabel = '';
            if (i === 0 || (msg.timestamp - history[i - 1].timestamp > 300000)) {
                timeLabel = `<div class="chat-time-label">${this.formatMessageTime(msg.timestamp)}</div>`;
            }

            // 系统消息
            if (msg.type === 'system') {
                return `${timeLabel}<div class="chat-system-msg">${this.escapeHtml(msg.content)}</div>`;
            }

            // 拍一拍
            if (msg.type === 'pat') {
                return `${timeLabel}<div class="chat-pat-msg">"${msg.sender}" 拍了拍 "${msg.target}"</div>`;
            }

            // 红包
            if (msg.type === 'redpacket') {
                return `${timeLabel}
                    <div class="chat-message-row ${isSelf ? 'self' : ''}">
                        <img class="msg-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(msg.sender || '')}'" onclick="wechatSim.viewProfile('${msg.sender}')"/>
                        <div class="msg-content-wrapper">
                            ${!isSelf && isGroup ? `<div class="msg-sender-name">${msg.sender}</div>` : ''}
                            <div class="chat-bubble redpacket-msg ${msg.opened ? 'opened' : ''}" onclick="wechatSim.openRedPacket('${msg.id}', '${chatId}')">
                                <div class="redpacket-content">
                                    <div class="rp-icon">🧧</div>
                                    <div class="rp-text">${this.escapeHtml(msg.greeting || '恭喜发财，大吉大利')}</div>
                                </div>
                                <div class="redpacket-footer">微信红包${msg.opened ? ' · 已领取' : ''}</div>
                            </div>
                        </div>
                    </div>`;
            }

            // 礼物
            if (msg.type === 'gift') {
                return `${timeLabel}
                    <div class="chat-message-row ${isSelf ? 'self' : ''}">
                        <img class="msg-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(msg.sender || '')}'" />
                        <div class="msg-content-wrapper">
                            ${!isSelf && isGroup ? `<div class="msg-sender-name">${msg.sender}</div>` : ''}
                            <div class="chat-bubble gift-msg">
                                <div class="gift-icon">${msg.emoji || '🎁'}</div>
                                <div class="gift-name">${this.escapeHtml(msg.giftName || '礼物')}</div>
                                <div class="gift-desc">${this.escapeHtml(msg.content || '送你一份礼物')}</div>
                            </div>
                        </div>
                    </div>`;
            }

            // 图片
            if (msg.type === 'image') {
                return `${timeLabel}
                    <div class="chat-message-row ${isSelf ? 'self' : ''}">
                        <img class="msg-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(msg.sender || '')}'" onclick="wechatSim.viewProfile('${msg.sender}')"/>
                        <div class="msg-content-wrapper">
                            ${!isSelf && isGroup ? `<div class="msg-sender-name">${msg.sender}</div>` : ''}
                            <div class="chat-bubble image-msg">
                                <img src="${msg.url}" onerror="this.style.background='#eee';this.alt='图片加载失败'" onclick="wechatSim.viewImage('${msg.url}')" alt="图片"/>
                            </div>
                        </div>
                    </div>`;
            }

            // 视频
            if (msg.type === 'video') {
                return `${timeLabel}
                    <div class="chat-message-row ${isSelf ? 'self' : ''}">
                        <img class="msg-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(msg.sender || '')}'" />
                        <div class="msg-content-wrapper">
                            ${!isSelf && isGroup ? `<div class="msg-sender-name">${msg.sender}</div>` : ''}
                            <div class="chat-bubble video-msg" onclick="wechatSim.playVideo('${msg.url}')">
                                <video src="${msg.url}" preload="metadata"></video>
                                <div class="video-play-icon">${Icons.play}</div>
                            </div>
                        </div>
                    </div>`;
            }

            // 文本消息
            let content = this.escapeHtml(msg.content || '');
            // 处理@
            content = content.replace(/@(\S+)/g, '<span class="at-mention">@$1</span>');

            return `${timeLabel}
                <div class="chat-message-row ${isSelf ? 'self' : ''}">
                    <img class="msg-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(msg.sender || '')}'" onclick="wechatSim.viewProfile('${msg.sender}')"/>
                    <div class="msg-content-wrapper">
                        ${!isSelf && isGroup ? `<div class="msg-sender-name">${msg.sender}</div>` : ''}
                        <div class="chat-bubble">${content}</div>
                    </div>
                </div>`;
        }).join('');

        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar(title, true, chatActions)}
            <div class="wechat-screen">
                <div class="wechat-chat-page">
                    <div class="wechat-chat-messages" id="chat-messages">
                        ${messagesHtml}
                    </div>
                    <div class="wechat-chat-input-bar">
                        <div class="input-actions-left">
                            <button onclick="wechatSim.toggleVoice()" title="语音">${Icons.mic}</button>
                        </div>
                        <textarea class="chat-input-field" id="chat-input" rows="1" placeholder="输入消息..." oninput="wechatSim.onInputChange(this)" onkeydown="wechatSim.onInputKeydown(event)"></textarea>
                        <div class="input-actions-right">
                            <button onclick="wechatSim.toggleEmoji()" title="表情">${Icons.emoji}</button>
                            <button onclick="wechatSim.toggleMorePanel()" title="更多">${Icons.plus}</button>
                            <button class="send-msg-btn" id="send-btn" onclick="wechatSim.sendMessage('${chatId}', ${isGroup})">发送</button>
                        </div>
                    </div>
                    <div class="chat-more-panel" id="more-panel">
                        <div class="chat-more-item" onclick="wechatSim.sendPhoto('${chatId}', ${isGroup})">
                            <div class="more-icon">${Icons.image}</div>
                            <span>照片</span>
                        </div>
                        <div class="chat-more-item" onclick="wechatSim.sendVideoMsg('${chatId}', ${isGroup})">
                            <div class="more-icon">${Icons.video}</div>
                            <span>视频</span>
                        </div>
                        <div class="chat-more-item" onclick="wechatSim.sendRedPacket('${chatId}', ${isGroup})">
                            <div class="more-icon" style="background:#FA9D3B;">🧧</div>
                            <span>红包</span>
                        </div>
                        <div class="chat-more-item" onclick="wechatSim.sendGift('${chatId}', ${isGroup})">
                            <div class="more-icon" style="background:#C44AFF;">${Icons.gift}</div>
                            <span>礼物</span>
                        </div>
                        <div class="chat-more-item" onclick="wechatSim.doPat('${chatId}', ${isGroup})">
                            <div class="more-icon" style="background:#FF8800;">👋</div>
                            <span>拍一拍</span>
                        </div>
                        ${isGroup ? `
                        <div class="chat-more-item" onclick="wechatSim.atSomeone('${chatId}')">
                            <div class="more-icon" style="background:#576B95;">@</div>
                            <span>@某人</span>
                        </div>` : ''}
                        <div class="chat-more-item" onclick="wechatSim.sendFromBackpack('${chatId}', ${isGroup})">
                            <div class="more-icon" style="background:#07C160;">${Icons.backpack}</div>
                            <span>背包</span>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    findSenderInfo(senderName, groupOrFriend) {
        if (groupOrFriend.members) {
            return groupOrFriend.members.find(m => m.name === senderName);
        }
        return state.getFriend(senderName) || null;
    }

    formatMessageTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        if (isToday) {
            return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        }
        return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    }

    // 通讯录页面
    renderContactsPage() {
        const features = [
            { icon: '#FA9D3B', name: '新的朋友', action: 'addFriend' },
            { icon: '#07C160', name: '群聊', action: 'groupList' },
        ];

        // 好友按拼音排序（简化处理）
        const sortedFriends = [...state.settings.friends].sort((a, b) => a.name.localeCompare(b.name, 'zh'));

        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('通讯录', false, `<button onclick="wechatSim.showAddFriendDialog()">${Icons.addFriend}</button>`)}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-contacts-page">
                    <div class="wechat-search-bar">
                        <input type="text" placeholder="搜索" />
                    </div>
                    ${features.map(f => `
                        <div class="contact-feature-item" onclick="wechatSim.contactAction('${f.action}')">
                            <div class="feature-icon" style="background:${f.icon};">
                                ${f.action === 'addFriend' ? Icons.addFriend : Icons.contacts}
                            </div>
                            <span>${f.name}</span>
                        </div>
                    `).join('')}
                    <div class="contact-section-header">好友 (${sortedFriends.length})</div>
                    ${sortedFriends.map(f => `
                        <div class="contact-item" onclick="wechatSim.viewContactProfile('${f.id}')">
                            <img class="avatar" src="${f.avatar || this.defaultAvatar(f.name)}" onerror="this.src='${this.defaultAvatar(f.name)}'" />
                            <span class="contact-name">${f.name}</span>
                        </div>
                    `).join('')}
                    ${sortedFriends.length === 0 ? '<div style="text-align:center;padding:30px;color:#999;">暂无好友</div>' : ''}
                </div>
            </div>
            ${this.renderTabbar('contacts')}`;
    }

    // 发现页面
    renderDiscoverPage() {
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('发现')}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-discover-page">
                    <div class="discover-group">
                        <div class="discover-item" onclick="wechatSim.openMoments()">
                            <div class="discover-icon">${Icons.moments_icon}</div>
                            <span class="discover-text">朋友圈</span>
                            <span class="discover-arrow">›</span>
                        </div>
                    </div>
                    <div class="discover-group">
                        <div class="discover-item" onclick="wechatSim.openOfficialAccounts()">
                            <div class="discover-icon">${Icons.article}</div>
                            <span class="discover-text">公众号</span>
                            <span class="discover-arrow">›</span>
                        </div>
                    </div>
                    <div class="discover-group">
                        <div class="discover-item" onclick="wechatSim.openShop()">
                            <div class="discover-icon">${Icons.shop}</div>
                            <span class="discover-text">购物</span>
                            <span class="discover-arrow">›</span>
                        </div>
                    </div>
                    <div class="discover-group">
                        <div class="discover-item" onclick="wechatSim.openForum()">
                            <div class="discover-icon">${Icons.forum}</div>
                            <span class="discover-text">论坛</span>
                            <span class="discover-arrow">›</span>
                        </div>
                    </div>
                </div>
            </div>
            ${this.renderTabbar('discover')}`;
    }

    // 我的页面
    renderMePage() {
        const avatar = state.settings.playerAvatar || this.defaultAvatar(state.settings.playerName);
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('我')}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-me-page">
                    <div class="me-profile-card" onclick="wechatSim.editMyProfile()">
                        <img class="me-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(state.settings.playerName)}'" onclick="event.stopPropagation();wechatSim.changeMyAvatar()"/>
                        <div class="me-info">
                            <div class="me-name">${state.settings.playerName}</div>
                            <div class="me-id">微信号: ${state.settings.playerId}</div>
                        </div>
                    </div>
                    <div class="me-menu-group">
                        <div class="me-menu-item" onclick="wechatSim.openWallet()">
                            <div class="menu-icon">${Icons.wallet}</div>
                            <span class="menu-text">钱包</span>
                            <span class="menu-extra">¥${state.settings.walletBalance.toFixed(2)}</span>
                            <span class="menu-arrow">›</span>
                        </div>
                    </div>
                    <div class="me-menu-group">
                        <div class="me-menu-item" onclick="wechatSim.openBackpack()">
                            <div class="menu-icon">${Icons.backpack}</div>
                            <span class="menu-text">背包</span>
                            <span class="menu-extra">${state.settings.backpack.length}件</span>
                            <span class="menu-arrow">›</span>
                        </div>
                    </div>
                    <div class="me-menu-group">
                        <div class="me-menu-item" onclick="wechatSim.openMyPersona()">
                            <div class="menu-icon">${Icons.edit}</div>
                            <span class="menu-text">个人人设</span>
                            <span class="menu-arrow">›</span>
                        </div>
                        <div class="me-menu-item" onclick="wechatSim.openPluginSettings()">
                            <div class="menu-icon">${Icons.settings}</div>
                            <span class="menu-text">插件设置</span>
                            <span class="menu-arrow">›</span>
                        </div>
                    </div>
                </div>
            </div>
            ${this.renderTabbar('me')}`;
    }

    // ========== 子页面渲染 ==========

    // 朋友圈
    renderMomentsPage() {
        const moments = state.settings.moments.slice().reverse();
        const avatar = state.settings.playerAvatar || this.defaultAvatar(state.settings.playerName);

        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('朋友圈', true, `<button onclick="wechatSim.composeMoment()">${Icons.camera}</button>`)}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-moments-page">
                    <div class="moments-header">
                        <img class="moments-cover" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#1a1a2e"/><stop offset="100%" style="stop-color:#16213e"/></linearGradient></defs><rect fill="url(#g)" width="400" height="260"/><text x="200" y="140" fill="rgba(255,255,255,0.1)" font-size="48" text-anchor="middle">✨</text></svg>')}" />
                        <div class="moments-profile">
                            <span class="moments-profile-name">${state.settings.playerName}</span>
                            <img class="moments-profile-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(state.settings.playerName)}'" />
                        </div>
                    </div>
                    ${moments.map(m => this.renderMomentItem(m)).join('')}
                    ${moments.length === 0 ? '<div style="text-align:center;padding:40px;color:#999;">朋友圈空空如也~<br>发条动态吧</div>' : ''}
                </div>
            </div>`;
    }

    renderMomentItem(moment) {
        const avatar = moment.avatar || this.defaultAvatar(moment.author);
        const imagesHtml = moment.images && moment.images.length > 0 ? `
            <div class="moment-images cols-${Math.min(moment.images.length, 3)}">
                ${moment.images.map(img => `<img src="${img}" onerror="this.style.display='none'" onclick="wechatSim.viewImage('${img}')" />`).join('')}
            </div>` : '';

        const interactionsHtml = (moment.likes?.length > 0 || moment.comments?.length > 0) ? `
            <div class="moment-interactions">
                ${moment.likes?.length > 0 ? `
                    <div class="moment-likes">
                        <span class="like-icon">❤️</span>
                        ${moment.likes.map(n => `<span class="like-name">${n}</span>`).join('，')}
                    </div>` : ''}
                ${moment.comments?.length > 0 ? `
                    <div class="moment-comments">
                        ${moment.comments.map(c => `
                            <div class="moment-comment">
                                <span class="commenter">${c.sender}</span>${c.replyTo ? ` <span class="comment-reply-to">回复</span> <span class="commenter">${c.replyTo}</span>` : ''}：${this.escapeHtml(c.content)}
                            </div>
                        `).join('')}
                    </div>` : ''}
            </div>` : '';

        return `
            <div class="moment-item">
                <img class="moment-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(moment.author)}'" />
                <div class="moment-body">
                    <div class="moment-name">${moment.author}</div>
                    <div class="moment-text">${this.escapeHtml(moment.text)}</div>
                    ${imagesHtml}
                    <div class="moment-time-row">
                        <span class="moment-time">${this.formatTime(moment.timestamp)}</span>
                        <button class="moment-action-btn" onclick="wechatSim.likeMoment('${moment.id}')">
                            ${Icons.like}
                        </button>
                    </div>
                    ${interactionsHtml}
                </div>
            </div>`;
    }

    // 发朋友圈页面
    renderComposeMoment() {
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('发表', true, '<button onclick="wechatSim.publishMoment()" style="background:#07C160;color:white;border:none;border-radius:4px;padding:4px 12px;font-size:14px;cursor:pointer;">发表</button>')}
            <div class="wechat-screen">
                <div class="wechat-screen-content">
                    <div class="moment-compose">
                        <textarea id="moment-text" placeholder="这一刻的想法..."></textarea>
                        <div class="compose-images" id="compose-images">
                            <div class="add-image-btn" onclick="wechatSim.addMomentImage()">+</div>
                        </div>
                        <div style="margin-top:16px;">
                            <input type="text" class="wechat-input" id="moment-image-url" placeholder="输入图片链接(可选)" />
                        </div>
                    </div>
                </div>
            </div>`;
    }

    // 钱包页面
    renderWalletPage() {
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('钱包', true)}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-wallet-page">
                    <div class="wallet-balance-card">
                        <div class="balance-label">余额</div>
                        <div class="balance-amount">¥${state.settings.walletBalance.toFixed(2)}</div>
                    </div>
                    <div class="wallet-actions">
                        <div class="wallet-action-item" onclick="wechatSim.walletAction('recharge')">
                            <div class="action-icon">${Icons.plus}</div>
                            <span>充值</span>
                        </div>
                        <div class="wallet-action-item" onclick="wechatSim.walletAction('transfer')">
                            <div class="action-icon">${Icons.send}</div>
                            <span>转账</span>
                        </div>
                        <div class="wallet-action-item" onclick="wechatSim.walletAction('redpacket')">
                            <div class="action-icon" style="background:#FA9D3B;">🧧</div>
                            <span>红包</span>
                        </div>
                    </div>
                    <div style="background:white;margin:0 16px;border-radius:12px;padding:16px;">
                        <h4 style="margin:0 0 12px;color:#333;">交易记录</h4>
                        <div style="text-align:center;color:#999;padding:20px;">暂无交易记录</div>
                    </div>
                </div>
            </div>`;
    }

    // 背包页面
    renderBackpackPage() {
        const items = state.settings.backpack;
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('背包', true)}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-backpack-page">
                    ${items.length > 0 ? `
                        <div class="backpack-grid">
                            ${items.map(item => `
                                <div class="backpack-item" onclick="wechatSim.useBackpackItem('${item.name}')">
                                    <div class="item-icon">${item.emoji || '📦'}</div>
                                    <div class="item-name">${item.name}</div>
                                    ${item.count > 1 ? `<span class="item-count">×${item.count}</span>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    ` : '<div style="text-align:center;padding:60px;color:#999;">背包空空如也~<br>去购物页面逛逛吧</div>'}
                </div>
            </div>`;
    }

    // 公众号页面
    renderOfficialAccountsPage() {
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('公众号', true)}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-official-page">
                    <div class="wechat-search-bar">
                        <input type="text" id="oa-search" placeholder="搜索公众号" />
                        <button onclick="wechatSim.searchOfficialAccounts()" style="position:absolute;right:20px;top:14px;background:#07C160;color:white;border:none;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer;">搜索</button>
                    </div>
                    <div id="oa-results">
                        ${state.settings.officialAccounts.map(oa => `
                            <div class="official-account-item" onclick="wechatSim.openOfficialAccount('${oa.name}')">
                                <div class="oa-avatar" style="width:44px;height:44px;border-radius:50%;background:#07C160;display:flex;align-items:center;justify-content:center;font-size:24px;color:white;flex-shrink:0;">${oa.avatar || '📰'}</div>
                                <div class="oa-info">
                                    <div class="oa-name">${oa.name}</div>
                                    <div class="oa-desc">${oa.desc || ''}</div>
                                </div>
                            </div>
                        `).join('')}
                        ${state.settings.officialAccounts.length === 0 ? '<div style="text-align:center;padding:40px;color:#999;">搜索感兴趣的公众号</div>' : ''}
                    </div>
                </div>
            </div>`;
    }

    // 公众号文章列表
    renderOfficialAccountDetail(accountName, articles) {
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar(accountName, true, '<button onclick="wechatSim.pushArticles()" style="background:#07C160;color:white;border:none;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;">推送</button>')}
            <div class="wechat-screen">
                <div class="wechat-screen-content">
                    <div id="article-list">
                        ${(articles || []).map(a => `
                            <div class="official-article-item" onclick='wechatSim.readArticle(${JSON.stringify(a).replace(/'/g, "&#39;")})'>
                                <div class="article-title">${this.escapeHtml(a.title)}</div>
                                <div class="article-desc">${this.escapeHtml(a.summary || '')}</div>
                            </div>
                        `).join('')}
                        ${(!articles || articles.length === 0) ? '<div style="text-align:center;padding:40px;color:#999;">点击推送按钮获取最新文章</div>' : ''}
                    </div>
                </div>
            </div>`;
    }

    // 文章阅读页面
    renderArticleReader(article) {
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('文章', true)}
            <div class="wechat-screen">
                <div class="wechat-screen-content">
                    <div class="article-reader">
                        <div class="article-full-title">${this.escapeHtml(article.title)}</div>
                        <div class="article-meta">阅读 ${article.readCount || Math.floor(Math.random() * 10000)}</div>
                        <div class="article-body">${article.content ? article.content.split('\n').map(p => `<p>${this.escapeHtml(p)}</p>`).join('') : ''}</div>
                    </div>
                </div>
            </div>`;
    }

    // 购物页面
    renderShopPage(items) {
        const cart = state.settings.shoppingCart;
        const cartCount = cart.reduce((sum, c) => sum + c.qty, 0);
        const cartTotal = cart.reduce((sum, c) => sum + c.price * c.qty, 0);

        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('购物', true)}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-shop-page" style="padding-bottom:50px;">
                    <div class="shop-header">
                        <input class="shop-search" type="text" placeholder="搜索商品" />
                    </div>
                    <div class="shop-grid" id="shop-items">
                        ${(items || []).map(item => `
                            <div class="shop-item" onclick="wechatSim.addToCart('${this.escapeAttr(item.name)}', ${item.price}, '${item.emoji || '📦'}')">
                                <div class="shop-img" style="display:flex;align-items:center;justify-content:center;font-size:64px;background:#F7F7F7;">${item.emoji || '📦'}</div>
                                <div class="shop-info">
                                    <div class="shop-name">${this.escapeHtml(item.name)}</div>
                                    <div class="shop-price"><span class="unit">¥</span>${item.price}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    ${(!items || items.length === 0) ? `
                        <div style="text-align:center;padding:40px;">
                            <div class="wechat-loading"><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>
                            <div style="color:#999;margin-top:10px;">正在加载商品...</div>
                        </div>` : ''}
                </div>
                <div class="shop-cart-bar">
                    <div class="cart-icon-wrap" onclick="wechatSim.toggleCartPanel()">
                        ${Icons.shop}
                        ${cartCount > 0 ? `<span class="cart-badge">${cartCount}</span>` : ''}
                    </div>
                    <div class="cart-total"><span class="unit">¥</span>${cartTotal.toFixed(2)}</div>
                    <button class="cart-checkout-btn" onclick="wechatSim.checkout()">结算(${cartCount})</button>
                </div>
                <div class="cart-panel" id="cart-panel" style="display:none;">
                    <div class="cart-panel-header">
                        <span>购物车</span>
                        <button class="clear-cart" onclick="wechatSim.clearCart()">清空</button>
                    </div>
                    ${cart.map(c => `
                        <div class="cart-item">
                            <span class="cart-item-name">${c.emoji || ''} ${c.name}</span>
                            <span class="cart-item-price">¥${c.price}</span>
                            <div class="cart-qty-control">
                                <button onclick="wechatSim.changeCartQty('${this.escapeAttr(c.name)}', -1)">-</button>
                                <span>${c.qty}</span>
                                <button onclick="wechatSim.changeCartQty('${this.escapeAttr(c.name)}', 1)">+</button>
                            </div>
                        </div>
                    `).join('')}
                    ${cart.length === 0 ? '<div style="text-align:center;padding:20px;color:#999;">购物车是空的</div>' : ''}
                </div>
            </div>`;
    }

    // 论坛页面
    renderForumPage(posts) {
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('论坛', true, '<button onclick="wechatSim.refreshForum()" style="background:#07C160;color:white;border:none;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;">刷新</button>')}
            <div class="wechat-screen">
                <div class="wechat-screen-content wechat-forum-page">
                    ${(posts || []).map(p => `
                        <div class="forum-post">
                            <div class="post-header">
                                <img class="post-avatar" src="${this.defaultAvatar(p.author)}" />
                                <div>
                                    <div class="post-author">${p.author}</div>
                                    <div class="post-time">${p.time || '刚刚'}</div>
                                </div>
                            </div>
                            <div class="post-title">${this.escapeHtml(p.title)}</div>
                            <div class="post-content">${this.escapeHtml(p.content)}</div>
                            <div class="post-stats">
                                <span class="post-stat">${Icons.like} ${p.likes || 0}</span>
                                <span class="post-stat">${Icons.comment} ${p.comments || 0}</span>
                            </div>
                        </div>
                    `).join('')}
                    ${(!posts || posts.length === 0) ? `
                        <div style="text-align:center;padding:40px;">
                            <div class="wechat-loading"><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>
                            <div style="color:#999;margin-top:10px;">正在加载帖子...</div>
                        </div>` : ''}
                </div>
            </div>`;
    }

    // 联系人资料页面
    renderContactProfile(friendId) {
        const friend = state.getFriend(friendId);
        if (!friend) return this.renderContactsPage();

        const avatar = friend.avatar || this.defaultAvatar(friend.name);
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('详细资料', true)}
            <div class="wechat-screen">
                <div class="wechat-screen-content profile-page">
                    <div class="profile-card">
                        <div class="profile-avatar-section">
                            <img class="profile-large-avatar" src="${avatar}" onerror="this.src='${this.defaultAvatar(friend.name)}'" onclick="wechatSim.changeFriendAvatar('${friendId}')" />
                            <div class="profile-details">
                                <h3>${friend.name}</h3>
                                <p>微信号: ${friend.id}</p>
                                ${friend.signature ? `<p>${friend.signature}</p>` : ''}
                            </div>
                        </div>
                    </div>
                    <button class="profile-action-btn" onclick="wechatSim.openChat('${friendId}', false)">
                        发消息
                    </button>
                    <button class="profile-action-btn" style="background:#576B95;" onclick="wechatSim.editFriendInfo('${friendId}')">
                        修改信息
                    </button>
                    <button class="profile-action-btn danger" onclick="wechatSim.deleteFriend('${friendId}')">
                        删除好友
                    </button>
                </div>
            </div>`;
    }

    // 个人人设编辑页面
    renderPersonaPage() {
        return `
            ${this.renderStatusBar()}
            ${this.renderNavbar('个人人设', true, '<button onclick="wechatSim.savePersona()" style="background:#07C160;color:white;border:none;border-radius:4px;padding:4px 12px;font-size:14px;cursor:pointer;">保存</button>')}
            <div class="wechat-screen">
                <div class="wechat-screen-content" style="padding:16px;background:white;">
                    <div class="persona-editor">
                        <div class="settings-row">
                            <label>昵称</label>
                            <input class="wechat-input" id="persona-name" value="${state.settings.playerName}" />
                        </div>
                        <div class="settings-row">
                            <label>头像链接</label>
                            <input class="wechat-input" id="persona-avatar" value="${state.settings.playerAvatar}" placeholder="输入头像图片链接" />
                        </div>
                        <div class="settings-row">
                            <label>微信号</label>
                            <input class="wechat-input" id="persona-wxid" value="${state.settings.playerId}" />
                        </div>
                        <div class="settings-row">
                            <label>个性签名</label>
                            <input class="wechat-input" id="persona-signature" value="${state.settings.playerSignature}" />
                        </div>
                        <div class="settings-row">
                            <label>人设描述（AI回复时会参考）</label>
                            <textarea id="persona-desc" style="width:100%;min-height:120px;border:1px solid #E0E0E0;border-radius:6px;padding:8px;font-size:14px;outline:none;box-sizing:border-box;font-family:inherit;resize:vertical;">${state.settings.playerPersona}</textarea>
                        </div>
                        <div class="settings-row" style="margin-top:10px;">
                            <label>上传头像</label>
                            <input type="file" accept="image/*" onchange="wechatSim.uploadAvatar(this)" style="font-size:14px;" />
                        </div>
                    </div>
                </div>
            </div>`;
    }

    // ========== 弹窗 ==========

    showModal(title, bodyHtml, buttons = []) {
        const overlay = document.createElement('div');
        overlay.className = 'wechat-modal-overlay';
        overlay.innerHTML = `
            <div class="wechat-modal">
                <div class="wechat-modal-header">${title}</div>
                <div class="wechat-modal-body">${bodyHtml}</div>
                <div class="wechat-modal-footer">
                    ${buttons.map(b => `<button onclick="${b.action}">${b.label}</button>`).join('')}
                </div>
            </div>`;
        this.phone.querySelector('.wechat-screen').appendChild(overlay);
        return overlay;
    }

    closeModal() {
        const overlay = this.phone.querySelector('.wechat-modal-overlay');
        if (overlay) overlay.remove();
    }

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    escapeAttr(str) {
        if (!str) return '';
        return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
    }
}

// ============================================
// 主控制器
// ============================================
class WeChatSimController {
    constructor() {
        this.ui = new WeChatUI();
        this.currentChatId = null;
        this.currentChatIsGroup = false;
        this.currentOAName = '';
        this.currentArticles = [];
        this.shopItems = [];
        this.forumPosts = [];
        this.momentImages = [];
    }

    // 初始化
    async init() {
        state.init();
        this.createContainer();
        this.setupDefaultData();

        // 更新时间
        setInterval(() => {
            const timeEl = this.ui.phone?.querySelector('.wechat-statusbar .time');
            if (timeEl) timeEl.textContent = this.ui.getTimeStr();
        }, 30000);
    }

    setupDefaultData() {
        // 如果没有好友，添加一些默认好友（从世界书/角色卡读取）
        if (state.settings.friends.length === 0) {
            // 尝试从角色卡获取
            try {
                const context = getContext();
                if (context && context.characters) {
                    const chars = context.characters;
                    if (Array.isArray(chars)) {
                        chars.forEach(char => {
                            if (char && char.name) {
                                state.addFriend({
                                    id: 'char_' + char.name.replace(/\s/g, '_'),
                                    name: char.name,
                                    avatar: char.avatar ? `/characters/${char.avatar}` : '',
                                    persona: char.description || '',
                                    signature: char.personality || ''
                                });
                            }
                        });
                    }
                }
            } catch (e) { /* ignore */ }

            // 如果还是没有好友，添加示例
            if (state.settings.friends.length === 0) {
                state.addFriend({
                    id: 'friend_xiaoming',
                    name: '小明',
                    avatar: '',
                    persona: '一个热情开朗的朋友',
                    signature: '今天也是元气满满的一天'
                });
            }
        }
    }

    // 创建DOM容器
    createContainer() {
        const container = document.createElement('div');
        container.id = 'wechat-sim-container';
        container.innerHTML = `
            <div id="wechat-phone">
                <div class="wechat-screen" id="wechat-main-screen"></div>
                <button id="wechat-reply-btn" onclick="wechatSim.triggerReply()">💬 生成回复</button>
            </div>
            <button id="wechat-toggle-btn" onclick="wechatSim.togglePhone()">
                ${Icons.wechat}
                <span class="badge" style="display:none;">0</span>
            </button>
            <div id="wechat-settings-panel"></div>`;
        document.body.appendChild(container);

        this.ui.phone = document.getElementById('wechat-phone');
        this.renderCurrentPage();
    }

    // 切换手机显示
    togglePhone() {
        const phone = document.getElementById('wechat-phone');
        if (phone.classList.contains('active')) {
            phone.classList.remove('active');
            state.settings.isOpen = false;
        } else {
            phone.classList.add('active');
            state.settings.isOpen = true;
            this.renderCurrentPage();
        }
        state.save();
    }

    // 渲染当前页面
    renderCurrentPage() {
        const screen = document.getElementById('wechat-main-screen');
        if (!screen) return;

        let html = '';
        switch (state.currentPage) {
            case 'chat-list':
                html = this.ui.renderChatList();
                break;
            case 'contacts':
                html = this.ui.renderContactsPage();
                break;
            case 'discover':
                html = this.ui.renderDiscoverPage();
                break;
            case 'me':
                html = this.ui.renderMePage();
                break;
            case 'chat':
                html = this.ui.renderChatPage(this.currentChatId, this.currentChatIsGroup);
                break;
            case 'moments':
                html = this.ui.renderMomentsPage();
                break;
            case 'compose-moment':
                html = this.ui.renderComposeMoment();
                break;
            case 'wallet':
                html = this.ui.renderWalletPage();
                break;
            case 'backpack':
                html = this.ui.renderBackpackPage();
                break;
            case 'official-accounts':
                html = this.ui.renderOfficialAccountsPage();
                break;
            case 'official-account-detail':
                html = this.ui.renderOfficialAccountDetail(this.currentOAName, this.currentArticles);
                break;
            case 'article-reader':
                html = this.ui.renderArticleReader(this.currentArticle);
                break;
            case 'shop':
                html = this.ui.renderShopPage(this.shopItems);
                break;
            case 'forum':
                html = this.ui.renderForumPage(this.forumPosts);
                break;
            case 'contact-profile':
                html = this.ui.renderContactProfile(this.currentContactId);
                break;
            case 'persona':
                html = this.ui.renderPersonaPage();
                break;
            default:
                html = this.ui.renderChatList();
        }

        screen.innerHTML = html;

        // 滚动到底部（聊天页面）
        if (state.currentPage === 'chat') {
            this.scrollChatToBottom();
            this.updateReplyButton();
        } else {
            document.getElementById('wechat-reply-btn')?.classList.remove('visible');
        }
    }

    // 切换Tab
    switchTab(tabId) {
        const tabToPage = {
            'chats': 'chat-list',
            'contacts': 'contacts',
            'discover': 'discover',
            'me': 'me'
        };
        state.currentPage = tabToPage[tabId] || 'chat-list';
        state.pageStack = [];
        this.renderCurrentPage();
    }

    // 导航到页面
    navigateTo(page) {
        state.pageStack.push(state.currentPage);
        state.currentPage = page;
        this.renderCurrentPage();
    }

    // 返回上一页
    goBack() {
        if (state.pageStack.length > 0) {
            state.currentPage = state.pageStack.pop();
        } else {
            state.currentPage = 'chat-list';
        }
        this.renderCurrentPage();
    }

    // 滚动聊天到底部
    scrollChatToBottom() {
        setTimeout(() => {
            const msgContainer = document.getElementById('chat-messages');
            if (msgContainer) {
                msgContainer.scrollTop = msgContainer.scrollHeight;
            }
        }, 50);
    }

    // ========== 聊天功能 ==========

    // 打开聊天
    openChat(chatId, isGroup = false) {
        this.currentChatId = chatId;
        this.currentChatIsGroup = isGroup;
        this.navigateTo('chat');
    }

    // 输入变化
    onInputChange(textarea) {
        const sendBtn = document.getElementById('send-btn');
        if (textarea.value.trim()) {
            sendBtn.classList.add('visible');
        } else {
            sendBtn.classList.remove('visible');
        }
        // 自动调整高度
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
    }

    onInputKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const chatId = this.currentChatId;
            const isGroup = this.currentChatIsGroup;
            if (chatId) this.sendMessage(chatId, isGroup);
        }
    }

    // 发送消息
    sendMessage(chatId, isGroup) {
        const input = document.getElementById('chat-input');
        const text = input?.value?.trim();
        if (!text) return;

        state.addMessage(chatId, {
            type: 'text',
            content: text,
            sender: state.settings.playerName
        });

        input.value = '';
        input.style.height = 'auto';
        document.getElementById('send-btn')?.classList.remove('visible');

        state.pendingMessages++;
        this.renderCurrentPage();
        this.updateReplyButton();
    }

    // 更新回复按钮
    updateReplyButton() {
        const btn = document.getElementById('wechat-reply-btn');
        if (!btn) return;
        if (state.currentPage === 'chat' && state.pendingMessages > 0) {
            btn.classList.add('visible');
            btn.textContent = `💬 生成回复 (${state.pendingMessages}条待回复)`;
        } else {
            btn.classList.remove('visible');
        }
    }

    // 触发AI回复（手机外按钮）
    async triggerReply() {
        if (state.isGenerating) return;
        state.isGenerating = true;

        const btn = document.getElementById('wechat-reply-btn');
        btn.classList.add('loading');
        btn.textContent = '💬 正在生成回复';

        try {
            const replies = await WeChatAPI.generateChatReply(
                this.currentChatId,
                this.currentChatIsGroup
            );

            for (const reply of replies) {
                const sender = reply.sender || WeChatAPI.getDefaultSender(this.currentChatId, this.currentChatIsGroup);

                // 尝试从世界书获取头像
                const charData = await WorldBookReader.getCharacterData(sender);

                if (reply.type === 'pat') {
                    state.addMessage(this.currentChatId, {
                        type: 'pat',
                        sender: reply.sender || sender,
                        target: reply.target || state.settings.playerName
                    });
                } else if (reply.type === 'redpacket') {
                    state.addMessage(this.currentChatId, {
                        type: 'redpacket',
                        sender: sender,
                        greeting: reply.greeting || '恭喜发财',
                        amount: reply.amount || Math.floor(Math.random() * 100) / 10,
                        opened: false
                    });
                } else if (reply.type === 'image') {
                    let url = reply.url;
                    // 尝试从世界书获取真实图片
                    if (!url || url.includes('描述')) {
                        const mediaUrl = await WorldBookReader.getMediaUrl(sender, 'photo');
                        if (mediaUrl) url = mediaUrl;
                    }
                    state.addMessage(this.currentChatId, {
                        type: 'image',
                        url: url || '',
                        sender: sender
                    });
                } else {
                    state.addMessage(this.currentChatId, {
                        type: 'text',
                        content: reply.content || reply.text || '',
                        sender: sender
                    });
                }
            }

            state.pendingMessages = 0;
            this.renderCurrentPage();
        } catch (e) {
            console.error("WeChatSim: 生成回复失败", e);
            this.ui.showToast("生成回复失败");
        }

        state.isGenerating = false;
        btn.classList.remove('loading');
        this.updateReplyButton();
    }

    // 发送照片
    sendPhoto(chatId, isGroup) {
        const body = `
            <div>
                <label style="display:block;margin-bottom:8px;font-size:14px;">图片链接：</label>
                <input class="wechat-input" id="photo-url" placeholder="输入图片链接" />
                <label style="display:block;margin:12px 0 8px;font-size:14px;">或上传本地图片：</label>
                <input type="file" accept="image/*,image/gif" id="photo-file" style="font-size:14px;" />
            </div>`;
        this.ui.showModal('发送照片', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '发送', action: `wechatSim.confirmSendPhoto('${chatId}', ${isGroup})` }
        ]);
    }

    confirmSendPhoto(chatId, isGroup) {
        const url = document.getElementById('photo-url')?.value?.trim();
        const fileInput = document.getElementById('photo-file');

        if (url) {
            state.addMessage(chatId, {
                type: 'image',
                url: url,
                sender: state.settings.playerName
            });
            this.closeModal();
            state.pendingMessages++;
            this.renderCurrentPage();
            this.updateReplyButton();
        } else if (fileInput?.files?.length > 0) {
            const reader = new FileReader();
            reader.onload = (e) => {
                state.addMessage(chatId, {
                    type: 'image',
                    url: e.target.result,
                    sender: state.settings.playerName
                });
                this.closeModal();
                state.pendingMessages++;
                this.renderCurrentPage();
                this.updateReplyButton();
            };
            reader.readAsDataURL(fileInput.files[0]);
        } else {
            this.ui.showToast('请输入链接或选择文件');
        }
    }

    // 发送视频
    sendVideoMsg(chatId, isGroup) {
        const body = `
            <div>
                <label style="display:block;margin-bottom:8px;font-size:14px;">视频链接：</label>
                <input class="wechat-input" id="video-url" placeholder="输入视频链接" />
                <label style="display:block;margin:12px 0 8px;font-size:14px;">或上传本地视频：</label>
                <input type="file" accept="video/*" id="video-file" style="font-size:14px;" />
            </div>`;
        this.ui.showModal('发送视频', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '发送', action: `wechatSim.confirmSendVideo('${chatId}', ${isGroup})` }
        ]);
    }

    confirmSendVideo(chatId, isGroup) {
        const url = document.getElementById('video-url')?.value?.trim();
        const fileInput = document.getElementById('video-file');

        if (url) {
            state.addMessage(chatId, {
                type: 'video',
                url: url,
                sender: state.settings.playerName
            });
            this.closeModal();
            state.pendingMessages++;
            this.renderCurrentPage();
            this.updateReplyButton();
        } else if (fileInput?.files?.length > 0) {
            const reader = new FileReader();
            reader.onload = (e) => {
                state.addMessage(chatId, {
                    type: 'video',
                    url: e.target.result,
                    sender: state.settings.playerName
                });
                this.closeModal();
                state.pendingMessages++;
                this.renderCurrentPage();
                this.updateReplyButton();
            };
            reader.readAsDataURL(fileInput.files[0]);
        }
    }

    // 发送红包
    sendRedPacket(chatId, isGroup) {
        const body = `
            <div>
                <label style="display:block;margin-bottom:8px;font-size:14px;">红包金额：</label>
                <input class="wechat-input" id="rp-amount" type="number" placeholder="0.01-200" value="6.66" step="0.01" min="0.01" max="200" />
                <label style="display:block;margin:8px 0 8px;font-size:14px;">祝福语：</label>
                <input class="wechat-input" id="rp-greeting" placeholder="恭喜发财，大吉大利" value="恭喜发财，大吉大利" />
                ${isGroup ? `
                <label style="display:block;margin:8px 0 8px;font-size:14px;">红包类型：</label>
                <select class="wechat-select" id="rp-type">
                    <option value="normal">普通红包</option>
                    <option value="lucky">拼手气红包</option>
                </select>
                <label style="display:block;margin:8px 0 8px;font-size:14px;">红包个数：</label>
                <input class="wechat-input" id="rp-count" type="number" value="5" min="1" max="20" />
                ` : ''}
            </div>`;
        this.ui.showModal('发红包', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '塞钱进红包', action: `wechatSim.confirmRedPacket('${chatId}', ${isGroup})` }
        ]);
    }

    confirmRedPacket(chatId, isGroup) {
        const amount = parseFloat(document.getElementById('rp-amount')?.value) || 6.66;
        const greeting = document.getElementById('rp-greeting')?.value || '恭喜发财，大吉大利';
        const rpType = document.getElementById('rp-type')?.value || 'normal';

        if (amount > state.settings.walletBalance) {
            this.ui.showToast('余额不足');
            return;
        }

        state.settings.walletBalance -= amount;
        state.save();

        const msg = {
            type: 'redpacket',
            sender: state.settings.playerName,
            greeting: greeting,
            amount: amount,
            opened: false,
            rpType: rpType,
            isGroupRp: isGroup
        };

        if (isGroup && rpType === 'lucky') {
            const count = parseInt(document.getElementById('rp-count')?.value) || 5;
            msg.rpCount = count;
            msg.totalAmount = amount;
        }

        state.addMessage(chatId, msg);
        this.closeModal();
        state.pendingMessages++;
        this.renderCurrentPage();
        this.updateReplyButton();
    }

    // 打开红包
    openRedPacket(msgId, chatId) {
        const history = state.getChatHistory(chatId);
        const msg = history.find(m => m.id === msgId);
        if (!msg || msg.opened) {
            this.ui.showToast('红包已被领取');
            return;
        }

        // 如果是群里的拼手气红包
        if (msg.isGroupRp && msg.rpType === 'lucky') {
            this.showLuckyRedPacket(msg, chatId);
            return;
        }

        msg.opened = true;
        if (msg.sender !== state.settings.playerName) {
            state.settings.walletBalance += msg.amount;
        }
        state.save();

        const overlay = document.createElement('div');
        overlay.className = 'wechat-modal-overlay';
        overlay.innerHTML = `
            <div class="redpacket-open-modal">
                <div class="rp-sender-name">${msg.sender}的红包</div>
                <div class="rp-greeting">${msg.greeting}</div>
                <div class="rp-amount">¥${msg.amount.toFixed(2)}</div>
                <button class="rp-close" onclick="this.closest('.wechat-modal-overlay').remove();wechatSim.renderCurrentPage();">✕</button>
            </div>`;
        this.ui.phone.querySelector('.wechat-screen').appendChild(overlay);
    }

    showLuckyRedPacket(msg, chatId) {
        const group = state.getGroup(chatId);
        if (!group) return;

        const members = group.members.map(m => m.name);
        const count = Math.min(msg.rpCount || 5, members.length);
        const total = msg.totalAmount || msg.amount;

        // 生成随机分配
        let amounts = [];
        let remaining = total;
        for (let i = 0; i < count - 1; i++) {
            const max = remaining / (count - i) * 2;
            const amt = Math.round(Math.random() * max * 100) / 100;
            amounts.push(Math.max(0.01, amt));
            remaining -= amt;
        }
        amounts.push(Math.round(remaining * 100) / 100);

        // 随机分配给成员
        const shuffled = [...members].sort(() => Math.random() - 0.5).slice(0, count);
        const results = shuffled.map((name, i) => ({ name, amount: amounts[i] }));
        const luckiest = results.reduce((a, b) => a.amount > b.amount ? a : b);

        msg.opened = true;
        msg.luckyResults = results;
        state.save();

        // 自己抢到的
        const myResult = results.find(r => r.name === state.settings.playerName);
        if (myResult) {
            state.settings.walletBalance += myResult.amount;
            state.save();
        }

        const overlay = document.createElement('div');
        overlay.className = 'wechat-modal-overlay';
        overlay.innerHTML = `
            <div class="wechat-modal" style="max-width:300px;">
                <div class="wechat-modal-header">${msg.sender}的拼手气红包</div>
                <div class="wechat-modal-body">
                    <div class="lucky-result">
                        <div class="lucky-emoji">🏆</div>
                        <div class="lucky-label">手气最佳</div>
                        <div class="lucky-name">${luckiest.name}</div>
                        <div class="lucky-amount">¥${luckiest.amount.toFixed(2)}</div>
                    </div>
                    <div style="border-top:1px solid #eee;padding-top:10px;">
                        ${results.map(r => `
                            <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;">
                                <span>${r.name} ${r.name === luckiest.name ? '🏆' : ''}</span>
                                <span style="color:#FA9D3B;font-weight:600;">¥${r.amount.toFixed(2)}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="wechat-modal-footer">
                    <button onclick="this.closest('.wechat-modal-overlay').remove();wechatSim.renderCurrentPage();" style="color:#07C160;font-weight:600;">关闭</button>
                </div>
            </div>`;
        this.ui.phone.querySelector('.wechat-screen').appendChild(overlay);
    }

    // 发送礼物
    sendGift(chatId, isGroup) {
        const gifts = [
            { emoji: '🌹', name: '玫瑰花', price: 5.20 },
            { emoji: '💍', name: '钻戒', price: 520 },
            { emoji: '🧸', name: '泰迪熊', price: 66 },
            { emoji: '🎂', name: '生日蛋糕', price: 99 },
            { emoji: '🍫', name: '巧克力', price: 13.14 },
            { emoji: '🎸', name: '吉他', price: 188 },
            { emoji: '⌚', name: '手表', price: 999 },
            { emoji: '🏠', name: '房子', price: 9999 },
            { emoji: '🚗', name: '跑车', price: 8888 },
            { emoji: '✈️', name: '机票', price: 1314 },
            { emoji: '💐', name: '花束', price: 52 },
            { emoji: '🎮', name: '游戏机', price: 299 },
        ];

        const body = `
            <div style="max-height:250px;overflow-y:auto;">
                ${gifts.map(g => `
                    <div style="display:flex;align-items:center;padding:8px 0;cursor:pointer;border-bottom:1px solid #f0f0f0;" onclick="wechatSim.confirmGift('${chatId}', ${isGroup}, '${g.emoji}', '${g.name}', ${g.price})">
                        <span style="font-size:28px;margin-right:10px;">${g.emoji}</span>
                        <span style="flex:1;font-size:14px;">${g.name}</span>
                        <span style="color:#FA5151;font-size:14px;font-weight:600;">¥${g.price}</span>
                    </div>
                `).join('')}
            </div>
            <div style="margin-top:10px;">
                <input class="wechat-input" id="gift-custom-name" placeholder="自定义礼物名称" />
                <input class="wechat-input" id="gift-custom-price" type="number" placeholder="自定义金额" />
                <input class="wechat-input" id="gift-custom-emoji" placeholder="自定义emoji 如🎁" />
            </div>`;
        this.ui.showModal('送礼物', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '自定义发送', action: `wechatSim.sendCustomGift('${chatId}', ${isGroup})` }
        ]);
    }

    confirmGift(chatId, isGroup, emoji, name, price) {
        if (price > state.settings.walletBalance) {
            this.ui.showToast('余额不足');
            return;
        }

        state.settings.walletBalance -= price;
        state.addMessage(chatId, {
            type: 'gift',
            emoji: emoji,
            giftName: name,
            content: `送出了${name}`,
            sender: state.settings.playerName,
            price: price
        });
        state.save();
        this.closeModal();
        state.pendingMessages++;
        this.renderCurrentPage();
        this.updateReplyButton();
    }

    sendCustomGift(chatId, isGroup) {
        const name = document.getElementById('gift-custom-name')?.value || '礼物';
        const price = parseFloat(document.getElementById('gift-custom-price')?.value) || 1;
        const emoji = document.getElementById('gift-custom-emoji')?.value || '🎁';

        this.confirmGift(chatId, isGroup, emoji, name, price);
    }

    // 拍一拍
    doPat(chatId, isGroup) {
        if (isGroup) {
            const group = state.getGroup(chatId);
            if (!group) return;
            const members = group.members.filter(m => m.name !== state.settings.playerName);
            const body = `
                <div class="friend-select-list">
                    ${members.map(m => `
                        <div class="friend-select-item" onclick="wechatSim.confirmPat('${chatId}', '${m.name}')">
                            <img class="fs-avatar" src="${m.avatar || this.ui.defaultAvatar(m.name)}" onerror="this.src='${this.ui.defaultAvatar(m.name)}'" />
                            <span class="fs-name">${m.name}</span>
                        </div>
                    `).join('')}
                </div>`;
            this.ui.showModal('拍一拍', body, [
                { label: '取消', action: 'wechatSim.closeModal()' }
            ]);
        } else {
            const friend = state.getFriend(chatId);
            if (friend) this.confirmPat(chatId, friend.name);
        }
    }

    confirmPat(chatId, targetName) {
        state.addMessage(chatId, {
            type: 'pat',
            sender: state.settings.playerName,
            target: targetName
        });
        this.closeModal();
        this.renderCurrentPage();
    }

    // @某人
    atSomeone(chatId) {
        const group = state.getGroup(chatId);
        if (!group) return;
        const members = group.members.filter(m => m.name !== state.settings.playerName);
        const body = `
            <div class="friend-select-list">
                ${members.map(m => `
                    <div class="friend-select-item" onclick="wechatSim.insertAt('${m.name}')">
                        <img class="fs-avatar" src="${m.avatar || this.ui.defaultAvatar(m.name)}" onerror="this.src='${this.ui.defaultAvatar(m.name)}'" />
                        <span class="fs-name">${m.name}</span>
                    </div>
                `).join('')}
            </div>`;
        this.ui.showModal('@某人', body, [
            { label: '取消', action: 'wechatSim.closeModal()' }
        ]);
    }

    insertAt(name) {
        const input = document.getElementById('chat-input');
        if (input) {
            input.value += `@${name} `;
            input.focus();
        }
        this.closeModal();
    }

    // 从背包发送
    sendFromBackpack(chatId, isGroup) {
        const items = state.settings.backpack;
        if (items.length === 0) {
            this.ui.showToast('背包为空');
            return;
        }
        const body = `
            <div class="friend-select-list">
                ${items.map(item => `
                    <div class="friend-select-item" onclick="wechatSim.confirmSendFromBackpack('${chatId}', ${isGroup}, '${this.ui.escapeAttr(item.name)}')">
                        <span style="font-size:28px;width:36px;text-align:center;">${item.emoji || '📦'}</span>
                        <span class="fs-name">${item.name} (×${item.count})</span>
                    </div>
                `).join('')}
            </div>`;
        this.ui.showModal('从背包送出', body, [
            { label: '取消', action: 'wechatSim.closeModal()' }
        ]);
    }

    confirmSendFromBackpack(chatId, isGroup, itemName) {
        const item = state.settings.backpack.find(i => i.name === itemName);
        if (!item) return;

        state.addMessage(chatId, {
            type: 'gift',
            emoji: item.emoji || '📦',
            giftName: item.name,
            content: `从背包送出了${item.name}`,
            sender: state.settings.playerName
        });
        state.removeFromBackpack(itemName);
        this.closeModal();
        state.pendingMessages++;
        this.renderCurrentPage();
        this.updateReplyButton();
    }

    // 查看图片
    viewImage(url) {
        const overlay = document.createElement('div');
        overlay.className = 'image-viewer-overlay';
        overlay.onclick = () => overlay.remove();
        overlay.innerHTML = `<img src="${url}" />`;
        this.ui.phone.querySelector('.wechat-screen').appendChild(overlay);
    }

    // 播放视频
    playVideo(url) {
        const overlay = document.createElement('div');
        overlay.className = 'video-player-overlay';
        overlay.innerHTML = `
            <video src="${url}" controls autoplay style="max-width:100%;max-height:100%;"></video>
            <button class="close-video" onclick="this.closest('.video-player-overlay').remove()">✕</button>`;
        this.ui.phone.querySelector('.wechat-screen').appendChild(overlay);
    }

    // 切换更多面板
    toggleMorePanel() {
        const panel = document.getElementById('more-panel');
        if (panel) {
            panel.classList.toggle('visible');
        }
    }

    toggleVoice() {
        this.ui.showToast('语音功能模拟中...');
    }

    toggleEmoji() {
        const emojis = ['😊', '😂', '🤣', '❤️', '😍', '🤔', '😢', '😎', '👍', '🙏', '🎉', '😴', '😭', '😘', '🥰', '😤', '😱', '🤗', '👋', '✨', '🔥', '💪', '🤝', '👏'];
        const body = `
            <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;">
                ${emojis.map(e => `
                    <span style="font-size:28px;cursor:pointer;padding:4px;" onclick="wechatSim.insertEmoji('${e}')">${e}</span>
                `).join('')}
            </div>`;
        this.ui.showModal('表情', body, [
            { label: '关闭', action: 'wechatSim.closeModal()' }
        ]);
    }

    insertEmoji(emoji) {
        const input = document.getElementById('chat-input');
        if (input) {
            input.value += emoji;
            input.focus();
            this.onInputChange(input);
        }
        this.closeModal();
    }

    closeModal() {
        this.ui.closeModal();
    }

    // 搜索聊天
    searchChats(query) {
        const items = document.querySelectorAll('#chat-list-items .chat-list-item');
        items.forEach(item => {
            const name = item.querySelector('.name-text')?.textContent || '';
            item.style.display = name.includes(query) ? 'flex' : 'none';
        });
    }

    // 聊天菜单
    showChatMenu(chatId, isGroup) {
        const body = `
            <div>
                <div class="friend-select-item" onclick="wechatSim.clearChatHistory('${chatId}')">
                    <span style="font-size:20px;">🗑️</span>
                    <span class="fs-name">清空聊天记录</span>
                </div>
                ${isGroup ? `
                <div class="friend-select-item" onclick="wechatSim.viewGroupMembers('${chatId}')">
                    <span style="font-size:20px;">👥</span>
                    <span class="fs-name">群成员</span>
                </div>` : `
                <div class="friend-select-item" onclick="wechatSim.viewContactProfile('${chatId}')">
                    <span style="font-size:20px;">👤</span>
                    <span class="fs-name">查看资料</span>
                </div>`}
            </div>`;
        this.ui.showModal('聊天设置', body, [
            { label: '关闭', action: 'wechatSim.closeModal()' }
        ]);
    }

    clearChatHistory(chatId) {
        state.settings.chatHistories[chatId] = [];
        state.save();
        this.closeModal();
        this.renderCurrentPage();
    }

    viewGroupMembers(chatId) {
        const group = state.getGroup(chatId);
        if (!group) return;
        this.closeModal();

        const body = `
            <div class="group-members-grid">
                ${group.members.map(m => `
                    <div class="group-member-item">
                        <img src="${m.avatar || this.ui.defaultAvatar(m.name)}" onerror="this.src='${this.ui.defaultAvatar(m.name)}'" />
                        <div class="member-name">${m.name}</div>
                    </div>
                `).join('')}
            </div>`;
        this.ui.showModal(`群成员 (${group.members.length})`, body, [
            { label: '关闭', action: 'wechatSim.closeModal()' }
        ]);
    }

    // ========== 通讯录功能 ==========

    contactAction(action) {
        switch (action) {
            case 'addFriend':
                this.showAddFriendDialog();
                break;
            case 'groupList':
                this.showGroupList();
                break;
        }
    }

    // 添加好友对话框
    showAddFriendDialog() {
        const body = `
            <div>
                <input class="wechat-input" id="add-friend-name" placeholder="好友昵称" />
                <input class="wechat-input" id="add-friend-avatar" placeholder="头像链接 (可选)" />
                <textarea class="wechat-input" id="add-friend-persona" placeholder="好友人设描述 (可选)" style="min-height:60px;resize:vertical;"></textarea>
                <div style="margin-top:8px;padding:8px;background:#FFF7E6;border-radius:4px;font-size:12px;color:#FA9D3B;">
                    💡 系统会尝试从世界书中读取此人名对应的头像和信息
                </div>
            </div>`;
        this.ui.showModal('添加好友', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '添加', action: 'wechatSim.confirmAddFriend()' }
        ]);
    }

    async confirmAddFriend() {
        const name = document.getElementById('add-friend-name')?.value?.trim();
        const avatarInput = document.getElementById('add-friend-avatar')?.value?.trim();
        const persona = document.getElementById('add-friend-persona')?.value?.trim();

        if (!name) {
            this.ui.showToast('请输入好友昵称');
            return;
        }

        // 检查是否已存在
        const existing = state.settings.friends.find(f => f.name === name);
        if (existing) {
            this.ui.showToast('该好友已存在');
            return;
        }

        let avatar = avatarInput || '';

        // 尝试从世界书读取头像
        if (!avatar) {
            try {
                const charData = await WorldBookReader.getCharacterData(name);
                if (charData && charData.avatar) {
                    avatar = charData.avatar;
                }
            } catch (e) {
                console.warn('从世界书读取头像失败', e);
            }
        }

        // 尝试从聊天记录中提到的人名匹配酒馆角色
        if (!avatar) {
            try {
                const context = getContext();
                if (context && context.characters) {
                    const chars = Array.isArray(context.characters) ? context.characters : Object.values(context.characters);
                    const matched = chars.find(c => c && c.name && c.name.toLowerCase() === name.toLowerCase());
                    if (matched && matched.avatar) {
                        avatar = `/characters/${matched.avatar}`;
                    }
                }
            } catch (e) { /* ignore */ }
        }

        // 模拟添加好友的过程（先显示"正在验证"）
        this.closeModal();
        this.ui.showToast('正在发送好友申请...');

        // 模拟延迟
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 根据聊天记录中提到过的人名，模拟失败或成功
        const chatHistories = state.settings.chatHistories;
        let mentionedInChat = false;
        Object.values(chatHistories).forEach(history => {
            history.forEach(msg => {
                if (msg.content && msg.content.includes(name)) {
                    mentionedInChat = true;
                }
            });
        });

        // 如果聊天记录里提到过这个人名，尝试去世界书查找，找不到则失败
        if (mentionedInChat && !avatar) {
            // 再次从世界书尝试
            const worldData = await WorldBookReader.getCharacterData(name);
            if (!worldData) {
                this.ui.showToast(`"${name}" 添加失败：对方拒绝了你的请求`);

                // 添加系统通知到一个虚拟聊天
                state.addMessage('system_notifications', {
                    type: 'system',
                    content: `你向"${name}"发送的好友申请被拒绝`,
                    sender: '系统'
                });
                return;
            } else {
                avatar = worldData.avatar || avatar;
            }
        }

        const friendId = 'friend_' + name.replace(/\s/g, '_') + '_' + Date.now();
        state.addFriend({
            id: friendId,
            name: name,
            avatar: avatar,
            persona: persona || '',
            signature: '',
            addedAt: Date.now()
        });

        this.ui.showToast(`已添加"${name}"为好友`);
        this.renderCurrentPage();
    }

    // 添加好友按钮（从聊天中提到的人名自动尝试添加）
    async autoAddMentionedFriend(name) {
        // 先在世界书中查找
        let avatar = '';
        try {
            const charData = await WorldBookReader.getCharacterData(name);
            if (charData) {
                avatar = charData.avatar || '';
            }
        } catch (e) { /* ignore */ }

        // 没找到的话模拟失败
        if (!avatar) {
            this.ui.showToast(`添加"${name}"失败：无法找到该用户`);
            return false;
        }

        const friendId = 'friend_' + name.replace(/\s/g, '_') + '_' + Date.now();
        state.addFriend({
            id: friendId,
            name: name,
            avatar: avatar,
            persona: '',
            signature: ''
        });
        this.ui.showToast(`已添加"${name}"为好友`);
        return true;
    }

    // 显示群聊列表
    showGroupList() {
        const groups = state.settings.groups;
        const body = `
            <div>
                ${groups.map(g => `
                    <div class="friend-select-item" onclick="wechatSim.openChat('${g.id}', true);wechatSim.closeModal();">
                        <img class="fs-avatar" src="${g.avatar || this.ui.defaultAvatar(g.name)}" onerror="this.src='${this.ui.defaultAvatar(g.name)}'" />
                        <span class="fs-name">${g.name} (${g.members?.length || 0}人)</span>
                    </div>
                `).join('')}
                ${groups.length === 0 ? '<div style="text-align:center;padding:20px;color:#999;">暂无群聊</div>' : ''}
                <div style="margin-top:12px;border-top:1px solid #eee;padding-top:12px;">
                    <button class="settings-btn" onclick="wechatSim.showCreateGroupDialog()">创建群聊</button>
                </div>
            </div>`;
        this.ui.showModal('群聊列表', body, [
            { label: '关闭', action: 'wechatSim.closeModal()' }
        ]);
    }

    // 创建群聊
    showCreateGroupDialog() {
        this.closeModal();
        const friends = state.settings.friends;
        const body = `
            <div>
                <input class="wechat-input" id="group-name" placeholder="群聊名称" />
                <div style="font-size:13px;color:#888;margin-bottom:8px;">选择群成员：</div>
                <div class="friend-select-list" style="max-height:200px;overflow-y:auto;">
                    ${friends.map(f => `
                        <label class="friend-select-item" style="cursor:pointer;">
                            <input type="checkbox" class="group-member-check" value="${f.id}" data-name="${f.name}" data-avatar="${f.avatar || ''}" style="margin-right:8px;" />
                            <img class="fs-avatar" src="${f.avatar || this.ui.defaultAvatar(f.name)}" onerror="this.src='${this.ui.defaultAvatar(f.name)}'" />
                            <span class="fs-name">${f.name}</span>
                        </label>
                    `).join('')}
                </div>
            </div>`;
        this.ui.showModal('创建群聊', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '创建', action: 'wechatSim.confirmCreateGroup()' }
        ]);
    }

    confirmCreateGroup() {
        const name = document.getElementById('group-name')?.value?.trim();
        if (!name) {
            this.ui.showToast('请输入群名称');
            return;
        }

        const checkboxes = document.querySelectorAll('.group-member-check:checked');
        const members = [
            {
                id: state.settings.playerId,
                name: state.settings.playerName,
                avatar: state.settings.playerAvatar || ''
            }
        ];

        checkboxes.forEach(cb => {
            const friendId = cb.value;
            const friend = state.getFriend(friendId);
            if (friend) {
                members.push({
                    id: friend.id,
                    name: friend.name,
                    avatar: friend.avatar || ''
                });
            }
        });

        if (members.length < 2) {
            this.ui.showToast('至少选择1个好友');
            return;
        }

        const groupId = 'group_' + Date.now();
        const group = {
            id: groupId,
            name: name,
            avatar: '',
            members: members,
            createdAt: Date.now()
        };

        state.settings.groups.push(group);
        state.save();

        // 发送创建系统消息
        state.addMessage(groupId, {
            type: 'system',
            content: `${state.settings.playerName} 创建了群聊"${name}"`,
            sender: '系统'
        });

        this.closeModal();
        this.openChat(groupId, true);
    }

    // 查看联系人资料
    viewContactProfile(friendId) {
        this.currentContactId = friendId;
        this.navigateTo('contact-profile');
    }

    // 查看个人资料（从聊天头像点击）
    viewProfile(senderName) {
        if (senderName === state.settings.playerName) {
            this.editMyProfile();
            return;
        }
        const friend = state.settings.friends.find(f => f.name === senderName);
        if (friend) {
            this.viewContactProfile(friend.id);
        }
    }

    // 删除好友
    deleteFriend(friendId) {
        const friend = state.getFriend(friendId);
        if (!friend) return;

        const body = `<div style="text-align:center;font-size:15px;">确定要删除好友"${friend.name}"吗？<br><span style="color:#999;font-size:13px;">聊天记录将一并删除</span></div>`;
        this.ui.showModal('删除好友', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '删除', action: `wechatSim.confirmDeleteFriend('${friendId}')` }
        ]);
    }

    confirmDeleteFriend(friendId) {
        const friend = state.getFriend(friendId);
        state.removeFriend(friendId);
        this.closeModal();
        this.ui.showToast(`已删除好友"${friend?.name || ''}"`);
        this.switchTab('contacts');
    }

    // 修改好友信息
    editFriendInfo(friendId) {
        const friend = state.getFriend(friendId);
        if (!friend) return;

        const body = `
            <div>
                <div class="settings-row">
                    <label>昵称</label>
                    <input class="wechat-input" id="edit-friend-name" value="${friend.name}" />
                </div>
                <div class="settings-row">
                    <label>头像链接</label>
                    <input class="wechat-input" id="edit-friend-avatar" value="${friend.avatar || ''}" placeholder="输入头像URL" />
                </div>
                <div class="settings-row">
                    <label>上传头像</label>
                    <input type="file" accept="image/*" id="edit-friend-avatar-file" style="font-size:13px;" />
                </div>
                <div class="settings-row">
                    <label>人设描述</label>
                    <textarea class="wechat-input" id="edit-friend-persona" style="min-height:60px;resize:vertical;">${friend.persona || ''}</textarea>
                </div>
                <div class="settings-row">
                    <label>个性签名</label>
                    <input class="wechat-input" id="edit-friend-sig" value="${friend.signature || ''}" />
                </div>
            </div>`;
        this.ui.showModal('修改好友信息', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '保存', action: `wechatSim.confirmEditFriend('${friendId}')` }
        ]);
    }

    confirmEditFriend(friendId) {
        const friend = state.getFriend(friendId);
        if (!friend) return;

        const name = document.getElementById('edit-friend-name')?.value?.trim();
        const avatar = document.getElementById('edit-friend-avatar')?.value?.trim();
        const persona = document.getElementById('edit-friend-persona')?.value?.trim();
        const sig = document.getElementById('edit-friend-sig')?.value?.trim();
        const fileInput = document.getElementById('edit-friend-avatar-file');

        if (name) friend.name = name;
        if (avatar) friend.avatar = avatar;
        if (persona !== undefined) friend.persona = persona;
        if (sig !== undefined) friend.signature = sig;

        // 处理文件上传
        if (fileInput?.files?.length > 0) {
            const reader = new FileReader();
            reader.onload = (e) => {
                friend.avatar = e.target.result;
                state.save();
                this.closeModal();
                this.renderCurrentPage();
            };
            reader.readAsDataURL(fileInput.files[0]);
            return;
        }

        state.save();
        this.closeModal();
        this.renderCurrentPage();
        this.ui.showToast('已保存');
    }

    // 修改好友头像
    changeFriendAvatar(friendId) {
        const body = `
            <div>
                <div class="settings-row">
                    <label>头像链接</label>
                    <input class="wechat-input" id="change-avatar-url" placeholder="输入图片链接" />
                </div>
                <div class="settings-row">
                    <label>上传本地图片</label>
                    <input type="file" accept="image/*" id="change-avatar-file" style="font-size:13px;" />
                </div>
            </div>`;
        this.ui.showModal('修改头像', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '确定', action: `wechatSim.confirmChangeFriendAvatar('${friendId}')` }
        ]);
    }

    confirmChangeFriendAvatar(friendId) {
        const friend = state.getFriend(friendId);
        if (!friend) return;

        const url = document.getElementById('change-avatar-url')?.value?.trim();
        const fileInput = document.getElementById('change-avatar-file');

        if (url) {
            friend.avatar = url;
            state.save();
            this.closeModal();
            this.renderCurrentPage();
        } else if (fileInput?.files?.length > 0) {
            const reader = new FileReader();
            reader.onload = (e) => {
                friend.avatar = e.target.result;
                state.save();
                this.closeModal();
                this.renderCurrentPage();
            };
            reader.readAsDataURL(fileInput.files[0]);
        }
    }

    // ========== 添加菜单(右上角+号) ==========

    showAddMenu() {
        const body = `
            <div>
                <div class="friend-select-item" onclick="wechatSim.closeModal();wechatSim.showAddFriendDialog();">
                    <span style="font-size:20px;">👤</span>
                    <span class="fs-name">添加好友</span>
                </div>
                <div class="friend-select-item" onclick="wechatSim.closeModal();wechatSim.showCreateGroupDialog();">
                    <span style="font-size:20px;">👥</span>
                    <span class="fs-name">创建群聊</span>
                </div>
                <div class="friend-select-item" onclick="wechatSim.closeModal();wechatSim.scanFromChatHistory();">
                    <span style="font-size:20px;">🔍</span>
                    <span class="fs-name">从聊天记录添加好友</span>
                </div>
            </div>`;
        this.ui.showModal('', body, [
            { label: '关闭', action: 'wechatSim.closeModal()' }
        ]);
    }

    // 从聊天记录中扫描提到的人名，尝试添加
    async scanFromChatHistory() {
        const allHistories = state.settings.chatHistories;
        const mentionedNames = new Set();
        const existingNames = new Set(state.settings.friends.map(f => f.name));
        existingNames.add(state.settings.playerName);

        // 扫描所有聊天记录
        Object.values(allHistories).forEach(history => {
            history.forEach(msg => {
                if (msg.sender && !existingNames.has(msg.sender) && msg.sender !== '系统') {
                    mentionedNames.add(msg.sender);
                }
                // 简单的人名提取（@后的名字）
                if (msg.content) {
                    const atMatches = msg.content.match(/@(\S+)/g);
                    if (atMatches) {
                        atMatches.forEach(m => {
                            const n = m.substring(1);
                            if (!existingNames.has(n)) mentionedNames.add(n);
                        });
                    }
                }
            });
        });

        if (mentionedNames.size === 0) {
            this.ui.showToast('未在聊天记录中找到新的人名');
            return;
        }

        const names = Array.from(mentionedNames);
        const body = `
            <div style="font-size:13px;color:#888;margin-bottom:8px;">在聊天记录中找到以下人名：</div>
            <div class="friend-select-list">
                ${names.map(n => `
                    <div class="friend-select-item" onclick="wechatSim.tryAutoAdd('${this.ui.escapeAttr(n)}', this)">
                        <img class="fs-avatar" src="${this.ui.defaultAvatar(n)}" />
                        <span class="fs-name">${n}</span>
                        <span style="font-size:12px;color:#07C160;margin-left:auto;">点击添加</span>
                    </div>
                `).join('')}
            </div>`;
        this.ui.showModal('从聊天记录添加', body, [
            { label: '关闭', action: 'wechatSim.closeModal()' }
        ]);
    }

    async tryAutoAdd(name, element) {
        if (element) {
            element.querySelector('span:last-child').textContent = '添加中...';
            element.style.pointerEvents = 'none';
        }

        // 尝试在世界书中查找
        let avatar = '';
        let persona = '';
        try {
            const charData = await WorldBookReader.getCharacterData(name);
            if (charData) {
                avatar = charData.avatar || '';
                persona = charData.persona || '';
            }
        } catch (e) { /* ignore */ }

        // 也尝试匹配酒馆角色
        if (!avatar) {
            try {
                const context = getContext();
                if (context && context.characters) {
                    const chars = Array.isArray(context.characters) ? context.characters : Object.values(context.characters);
                    const matched = chars.find(c => c && c.name && c.name.toLowerCase() === name.toLowerCase());
                    if (matched && matched.avatar) {
                        avatar = `/characters/${matched.avatar}`;
                    }
                }
            } catch (e) { /* ignore */ }
        }

        if (!avatar) {
            // 模拟失败
            if (element) {
                element.querySelector('span:last-child').textContent = '❌ 添加失败';
                element.querySelector('span:last-child').style.color = '#FA5151';
            }
            this.ui.showToast(`"${name}"添加失败：对方未开启好友验证`);
            return;
        }

        const friendId = 'friend_' + name.replace(/\s/g, '_') + '_' + Date.now();
        state.addFriend({
            id: friendId,
            name: name,
            avatar: avatar,
            persona: persona,
            signature: ''
        });

        if (element) {
            element.querySelector('span:last-child').textContent = '✅ 已添加';
            element.querySelector('span:last-child').style.color = '#07C160';
        }
        this.ui.showToast(`已添加"${name}"`);
    }

    // ========== 我的页面功能 ==========

    // 编辑个人资料
    editMyProfile() {
        this.navigateTo('persona');
    }

    // 修改自己的头像
    changeMyAvatar() {
        const body = `
            <div>
                <div class="settings-row">
                    <label>头像链接</label>
                    <input class="wechat-input" id="my-avatar-url" value="${state.settings.playerAvatar}" placeholder="输入图片链接" />
                </div>
                <div class="settings-row">
                    <label>上传本地图片</label>
                    <input type="file" accept="image/*" id="my-avatar-file" style="font-size:13px;" />
                </div>
            </div>`;
        this.ui.showModal('修改头像', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '确定', action: 'wechatSim.confirmChangeMyAvatar()' }
        ]);
    }

    confirmChangeMyAvatar() {
        const url = document.getElementById('my-avatar-url')?.value?.trim();
        const fileInput = document.getElementById('my-avatar-file');

        if (url) {
            state.settings.playerAvatar = url;
            state.save();
            this.closeModal();
            this.renderCurrentPage();
        } else if (fileInput?.files?.length > 0) {
            const reader = new FileReader();
            reader.onload = (e) => {
                state.settings.playerAvatar = e.target.result;
                state.save();
                this.closeModal();
                this.renderCurrentPage();
            };
            reader.readAsDataURL(fileInput.files[0]);
        }
    }

    uploadAvatar(input) {
        if (input?.files?.length > 0) {
            const reader = new FileReader();
            reader.onload = (e) => {
                document.getElementById('persona-avatar').value = e.target.result;
            };
            reader.readAsDataURL(input.files[0]);
        }
    }

    // 保存人设
    savePersona() {
        state.settings.playerName = document.getElementById('persona-name')?.value?.trim() || '我';
        state.settings.playerAvatar = document.getElementById('persona-avatar')?.value?.trim() || '';
        state.settings.playerId = document.getElementById('persona-wxid')?.value?.trim() || 'wxid_player';
        state.settings.playerSignature = document.getElementById('persona-signature')?.value?.trim() || '';
        state.settings.playerPersona = document.getElementById('persona-desc')?.value?.trim() || '';
        state.save();
        this.ui.showToast('已保存');
        this.goBack();
    }

    // 打开个人人设
    openMyPersona() {
        this.navigateTo('persona');
    }

    // ========== 钱包 ==========

    openWallet() {
        this.navigateTo('wallet');
    }

    walletAction(type) {
        switch (type) {
            case 'recharge':
                const body1 = `
                    <div>
                        <label style="font-size:14px;">充值金额：</label>
                        <input class="wechat-input" id="recharge-amount" type="number" placeholder="输入金额" value="100" />
                    </div>`;
                this.ui.showModal('充值', body1, [
                    { label: '取消', action: 'wechatSim.closeModal()' },
                    { label: '充值', action: 'wechatSim.confirmRecharge()' }
                ]);
                break;
            case 'transfer':
                const friends = state.settings.friends;
                const body2 = `
                    <div>
                        <label style="font-size:14px;">转账对象：</label>
                        <select class="wechat-select" id="transfer-target">
                            ${friends.map(f => `<option value="${f.id}">${f.name}</option>`).join('')}
                        </select>
                        <label style="font-size:14px;">转账金额：</label>
                        <input class="wechat-input" id="transfer-amount" type="number" placeholder="输入金额" />
                    </div>`;
                this.ui.showModal('转账', body2, [
                    { label: '取消', action: 'wechatSim.closeModal()' },
                    { label: '转账', action: 'wechatSim.confirmTransfer()' }
                ]);
                break;
            case 'redpacket':
                this.closeModal();
                this.goBack();
                this.ui.showToast('请在聊天中发送红包');
                break;
        }
    }

    confirmRecharge() {
        const amount = parseFloat(document.getElementById('recharge-amount')?.value) || 0;
        if (amount <= 0) {
            this.ui.showToast('请输入有效金额');
            return;
        }
        state.settings.walletBalance += amount;
        state.save();
        this.closeModal();
        this.renderCurrentPage();
        this.ui.showToast(`充值成功 +¥${amount.toFixed(2)}`);
    }

    confirmTransfer() {
        const targetId = document.getElementById('transfer-target')?.value;
        const amount = parseFloat(document.getElementById('transfer-amount')?.value) || 0;

        if (amount <= 0) {
            this.ui.showToast('请输入有效金额');
            return;
        }
        if (amount > state.settings.walletBalance) {
            this.ui.showToast('余额不足');
            return;
        }

        const friend = state.getFriend(targetId);
        if (!friend) {
            this.ui.showToast('好友不存在');
            return;
        }

        state.settings.walletBalance -= amount;
        state.save();

        // 在聊天中添加转账消息
        state.addMessage(targetId, {
            type: 'system',
            content: `你向${friend.name}转账了¥${amount.toFixed(2)}`,
            sender: '系统'
        });

        this.closeModal();
        this.renderCurrentPage();
        this.ui.showToast(`已向${friend.name}转账¥${amount.toFixed(2)}`);
    }

    // ========== 背包 ==========

    openBackpack() {
        this.navigateTo('backpack');
    }

    useBackpackItem(itemName) {
        const item = state.settings.backpack.find(i => i.name === itemName);
        if (!item) return;

        const friends = state.settings.friends;
        const body = `
            <div style="text-align:center;margin-bottom:12px;">
                <span style="font-size:48px;">${item.emoji || '📦'}</span>
                <div style="font-size:16px;font-weight:600;margin-top:4px;">${item.name}</div>
                <div style="font-size:13px;color:#888;">×${item.count}</div>
            </div>
            <div style="font-size:14px;color:#666;margin-bottom:8px;">送给好友：</div>
            <div class="friend-select-list" style="max-height:200px;">
                ${friends.map(f => `
                    <div class="friend-select-item" onclick="wechatSim.giftToFriend('${f.id}', '${this.ui.escapeAttr(itemName)}')">
                        <img class="fs-avatar" src="${f.avatar || this.ui.defaultAvatar(f.name)}" onerror="this.src='${this.ui.defaultAvatar(f.name)}'" />
                        <span class="fs-name">${f.name}</span>
                    </div>
                `).join('')}
            </div>`;
        this.ui.showModal('使用物品', body, [
            { label: '关闭', action: 'wechatSim.closeModal()' },
            { label: '丢弃', action: `wechatSim.discardItem('${this.ui.escapeAttr(itemName)}')` }
        ]);
    }

    giftToFriend(friendId, itemName) {
        const item = state.settings.backpack.find(i => i.name === itemName);
        const friend = state.getFriend(friendId);
        if (!item || !friend) return;

        state.addMessage(friendId, {
            type: 'gift',
            emoji: item.emoji || '📦',
            giftName: item.name,
            content: `从背包送出了${item.name}`,
            sender: state.settings.playerName
        });

        state.removeFromBackpack(itemName);
        this.closeModal();
        state.pendingMessages++;
        this.ui.showToast(`已将${item.name}送给${friend.name}`);
        this.renderCurrentPage();
    }

    discardItem(itemName) {
        state.removeFromBackpack(itemName);
        this.closeModal();
        this.renderCurrentPage();
        this.ui.showToast('已丢弃');
    }

    // ========== 朋友圈功能 ==========

    openMoments() {
        this.navigateTo('moments');
    }

    composeMoment() {
        this.momentImages = [];
        this.navigateTo('compose-moment');
    }

    addMomentImage() {
        const urlInput = document.getElementById('moment-image-url');
        const url = urlInput?.value?.trim();

        if (url) {
            this.momentImages.push(url);
            urlInput.value = '';
            this.updateComposeImages();
        } else {
            // 创建文件选择
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.onchange = (e) => {
                Array.from(e.target.files).forEach(file => {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        this.momentImages.push(ev.target.result);
                        this.updateComposeImages();
                    };
                    reader.readAsDataURL(file);
                });
            };
            input.click();
        }
    }

    updateComposeImages() {
        const container = document.getElementById('compose-images');
        if (!container) return;
        container.innerHTML = this.momentImages.map(img =>
            `<img src="${img}" style="width:80px;height:80px;object-fit:cover;border-radius:4px;" />`
        ).join('') + '<div class="add-image-btn" onclick="wechatSim.addMomentImage()">+</div>';
    }

    async publishMoment() {
        const text = document.getElementById('moment-text')?.value?.trim();
        if (!text) {
            this.ui.showToast('请输入内容');
            return;
        }

        const moment = {
            id: 'moment_' + Date.now(),
            author: state.settings.playerName,
            avatar: state.settings.playerAvatar || '',
            text: text,
            images: [...this.momentImages],
            timestamp: Date.now(),
            likes: [],
            comments: []
        };

        state.settings.moments.push(moment);
        state.save();

        this.ui.showToast('已发布');
        this.goBack();

        // 异步生成评论和点赞
        this.generateMomentReactions(moment);
    }

    async generateMomentReactions(moment) {
        try {
            const reactions = await WeChatAPI.generateMomentComments(moment.text);

            const m = state.settings.moments.find(mo => mo.id === moment.id);
            if (m) {
                m.likes = reactions.likes || [];
                m.comments = (reactions.comments || []).map(c => ({
                    sender: c.sender,
                    content: c.content,
                    replyTo: c.replyTo || null,
                    image: c.image || null
                }));
                state.save();

                // 如果当前在朋友圈页面，刷新
                if (state.currentPage === 'moments') {
                    this.renderCurrentPage();
                }
            }
        } catch (e) {
            console.error('生成朋友圈回复失败', e);
        }
    }

    likeMoment(momentId) {
        const moment = state.settings.moments.find(m => m.id === momentId);
        if (!moment) return;

        const playerName = state.settings.playerName;
        if (moment.likes.includes(playerName)) {
            moment.likes = moment.likes.filter(n => n !== playerName);
        } else {
            moment.likes.push(playerName);
        }
        state.save();
        this.renderCurrentPage();
    }

    // ========== 公众号功能 ==========

    openOfficialAccounts() {
        this.navigateTo('official-accounts');
    }

    async searchOfficialAccounts() {
        const query = document.getElementById('oa-search')?.value?.trim();
        if (!query) {
            this.ui.showToast('请输入搜索内容');
            return;
        }

        this.ui.showToast('搜索中...');

        try {
            const accounts = await WeChatAPI.generateOfficialAccounts(query);
            state.settings.officialAccounts = accounts;
            state.save();
            this.renderCurrentPage();
        } catch (e) {
            this.ui.showToast('搜索失败');
        }
    }

    openOfficialAccount(name) {
        this.currentOAName = name;
        this.currentArticles = [];
        this.navigateTo('official-account-detail');
    }

    async pushArticles() {
        this.ui.showToast('正在获取文章...');

        try {
            const articles = await WeChatAPI.generateArticles(this.currentOAName);
            this.currentArticles = articles;
            this.renderCurrentPage();
        } catch (e) {
            this.ui.showToast('获取文章失败');
        }
    }

    readArticle(article) {
        this.currentArticle = article;
        this.navigateTo('article-reader');
    }

    // ========== 购物功能 ==========

    async openShop() {
        this.navigateTo('shop');

        if (this.shopItems.length === 0) {
            try {
                const items = await WeChatAPI.generateShopItems();
                this.shopItems = items;
                this.renderCurrentPage();
            } catch (e) {
                this.ui.showToast('加载商品失败');
            }
        }
    }

    addToCart(name, price, emoji) {
        const cart = state.settings.shoppingCart;
        const existing = cart.find(c => c.name === name);
        if (existing) {
            existing.qty++;
        } else {
            cart.push({ name, price, emoji, qty: 1 });
        }
        state.save();
        this.renderCurrentPage();
        this.ui.showToast(`已加入购物车：${name}`);
    }

    changeCartQty(name, delta) {
        const cart = state.settings.shoppingCart;
        const item = cart.find(c => c.name === name);
        if (!item) return;

        item.qty += delta;
        if (item.qty <= 0) {
            state.settings.shoppingCart = cart.filter(c => c.name !== name);
        }
        state.save();
        this.renderCurrentPage();
    }

    clearCart() {
        state.settings.shoppingCart = [];
        state.save();
        this.renderCurrentPage();
    }

    toggleCartPanel() {
        const panel = document.getElementById('cart-panel');
        if (panel) {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }
    }

    checkout() {
        const cart = state.settings.shoppingCart;
        if (cart.length === 0) {
            this.ui.showToast('购物车是空的');
            return;
        }

        const total = cart.reduce((sum, c) => sum + c.price * c.qty, 0);

        if (total > state.settings.walletBalance) {
            this.ui.showToast('余额不足');
            return;
        }

        const body = `
            <div>
                <div style="font-size:14px;margin-bottom:10px;">购物清单：</div>
                ${cart.map(c => `
                    <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;">
                        <span>${c.emoji} ${c.name} ×${c.qty}</span>
                        <span style="color:#FA5151;">¥${(c.price * c.qty).toFixed(2)}</span>
                    </div>
                `).join('')}
                <div style="border-top:1px solid #eee;margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;font-weight:600;">
                    <span>合计</span>
                    <span style="color:#FA5151;font-size:18px;">¥${total.toFixed(2)}</span>
                </div>
                <div style="margin-top:12px;font-size:13px;color:#888;">购买后物品将放入背包</div>
            </div>`;
        this.ui.showModal('确认结算', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '支付', action: 'wechatSim.confirmCheckout()' }
        ]);
    }

    confirmCheckout() {
        const cart = state.settings.shoppingCart;
        const total = cart.reduce((sum, c) => sum + c.price * c.qty, 0);

        state.settings.walletBalance -= total;

        // 加入背包
        cart.forEach(c => {
            state.addToBackpack({
                name: c.name,
                emoji: c.emoji,
                price: c.price,
                count: c.qty
            });
        });

        state.settings.shoppingCart = [];
        state.save();

        this.closeModal();
        this.ui.showToast('购买成功！物品已放入背包');
        this.renderCurrentPage();
    }

    // ========== 论坛功能 ==========

    async openForum() {
        this.navigateTo('forum');

        if (this.forumPosts.length === 0) {
            try {
                const posts = await WeChatAPI.generateForumPosts();
                this.forumPosts = posts;
                this.renderCurrentPage();
            } catch (e) {
                this.ui.showToast('加载论坛失败');
            }
        }
    }

    async refreshForum() {
        this.ui.showToast('正在刷新...');
        try {
            const posts = await WeChatAPI.generateForumPosts();
            this.forumPosts = posts;
            this.renderCurrentPage();
        } catch (e) {
            this.ui.showToast('刷新失败');
        }
    }

    // ========== 插件设置 ==========

    openPluginSettings() {
        const panel = document.getElementById('wechat-settings-panel');
        if (!panel) return;

        const models = state.settings.availableModels;

        panel.innerHTML = `
            <div class="settings-header">
                <span>⚙️ WeChatSim 设置</span>
                <button class="settings-close" onclick="wechatSim.closeSettings()">✕</button>
            </div>
            <div class="settings-body">
                <div class="settings-group">
                    <h4>API 配置</h4>
                    <div class="settings-row">
                        <label>API 地址</label>
                        <input id="setting-api-endpoint" value="${state.settings.apiEndpoint}" placeholder="https://api.openai.com" />
                    </div>
                    <div class="settings-row">
                        <label>API Key</label>
                        <input id="setting-api-key" type="password" value="${state.settings.apiKey}" placeholder="sk-..." />
                    </div>
                    <div class="settings-row">
                        <button class="settings-btn" onclick="wechatSim.fetchModels()">拉取模型列表</button>
                    </div>
                    <div class="settings-row">
                        <label>选择模型</label>
                        <select id="setting-model">
                            <option value="">-- 请选择 --</option>
                            ${models.map(m => `<option value="${m.id}" ${m.id === state.settings.modelId ? 'selected' : ''}>${m.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="settings-row">
                        <label>自定义模型ID (手动输入)</label>
                        <input id="setting-model-custom" value="${state.settings.modelId}" placeholder="模型ID" />
                    </div>
                </div>

                <div class="settings-group">
                    <h4>生成参数</h4>
                    <div class="settings-row">
                        <label>最大Token数</label>
                        <input id="setting-max-tokens" type="number" value="${state.settings.maxTokens}" />
                    </div>
                    <div class="settings-row">
                        <label>Temperature</label>
                        <input id="setting-temperature" type="number" step="0.05" min="0" max="2" value="${state.settings.temperature}" />
                    </div>
                </div>

                <div class="settings-group">
                    <h4>世界书</h4>
                    <div class="settings-row">
                        <label>世界书名称</label>
                        <input id="setting-worldbook" value="${state.settings.worldBookName}" placeholder="WeChatSim" />
                    </div>
                    <div style="font-size:12px;color:#888;margin-top:4px;">
                        在酒馆世界书中创建条目，key为角色名，content包含：<br>
                        头像：图片链接<br>
                        照片：链接1,链接2<br>
                        视频：链接1,链接2<br>
                        人设：角色描述<br>
                        聊天风格：聊天风格描述
                    </div>
                </div>

                <div class="settings-group">
                    <h4>数据管理</h4>
                    <div class="settings-row">
                        <button class="settings-btn secondary" onclick="wechatSim.exportData()">导出数据</button>
                    </div>
                    <div class="settings-row">
                        <button class="settings-btn secondary" onclick="wechatSim.importData()">导入数据</button>
                        <input type="file" id="import-file" accept=".json" style="display:none;" onchange="wechatSim.processImport(this)" />
                    </div>
                    <div class="settings-row">
                        <button class="settings-btn" style="background:#FA5151;" onclick="wechatSim.resetAllData()">重置所有数据</button>
                    </div>
                </div>

                <div class="settings-group">
                    <button class="settings-btn" onclick="wechatSim.saveSettings()">保存设置</button>
                </div>
            </div>`;

        panel.classList.add('visible');
    }

    closeSettings() {
        document.getElementById('wechat-settings-panel')?.classList.remove('visible');
    }

    async fetchModels() {
        // 先保存当前输入的endpoint和key
        state.settings.apiEndpoint = document.getElementById('setting-api-endpoint')?.value?.trim() || '';
        state.settings.apiKey = document.getElementById('setting-api-key')?.value?.trim() || '';
        state.save();

        this.ui.showToast('正在拉取模型...');

        const models = await WeChatAPI.fetchModels();

        if (models.length > 0) {
            this.ui.showToast(`已获取 ${models.length} 个模型`);
            // 刷新设置面板
            this.openPluginSettings();
        } else {
            this.ui.showToast('未获取到模型，请检查API配置');
        }
    }

    saveSettings() {
        state.settings.apiEndpoint = document.getElementById('setting-api-endpoint')?.value?.trim() || '';
        state.settings.apiKey = document.getElementById('setting-api-key')?.value?.trim() || '';

        const modelSelect = document.getElementById('setting-model')?.value;
        const modelCustom = document.getElementById('setting-model-custom')?.value?.trim();
        state.settings.modelId = modelCustom || modelSelect || '';

        state.settings.maxTokens = parseInt(document.getElementById('setting-max-tokens')?.value) || 2048;
        state.settings.temperature = parseFloat(document.getElementById('setting-temperature')?.value) || 0.85;
        state.settings.worldBookName = document.getElementById('setting-worldbook')?.value?.trim() || 'WeChatSim';

        state.save();
        this.ui.showToast('设置已保存');
        this.closeSettings();
    }

    exportData() {
        const data = JSON.stringify(state.settings, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wechatsim_data_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.ui.showToast('数据已导出');
    }

    importData() {
        document.getElementById('import-file')?.click();
    }

    processImport(input) {
        if (!input.files?.length) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                Object.assign(state.settings, data);
                state.save();
                this.ui.showToast('数据已导入');
                this.renderCurrentPage();
                this.openPluginSettings();
            } catch (err) {
                this.ui.showToast('导入失败：无效的JSON');
            }
        };
        reader.readAsText(input.files[0]);
    }

    resetAllData() {
        const body = '<div style="text-align:center;font-size:15px;">确定要重置所有数据吗？<br><span style="color:#FA5151;font-size:13px;">此操作不可撤销！</span></div>';
        this.ui.showModal('重置确认', body, [
            { label: '取消', action: 'wechatSim.closeModal()' },
            { label: '确定重置', action: 'wechatSim.doReset()' }
        ]);
    }

    doReset() {
        Object.keys(defaultSettings).forEach(key => {
            state.settings[key] = JSON.parse(JSON.stringify(defaultSettings[key]));
        });
        state.save();
        this.closeModal();
        this.closeSettings();
        this.shopItems = [];
        this.forumPosts = [];
        this.switchTab('chats');
        this.ui.showToast('已重置所有数据');
    }
}

// ============================================
// 初始化插件
// ============================================
const controller = new WeChatSimController();
window.wechatSim = controller;

jQuery(async () => {
    try {
        await controller.init();
        console.log("WeChatSim: 插件已加载");
    } catch (e) {
        console.error("WeChatSim: 初始化失败", e);
    }
});

// 导出给SillyTavern
export { extensionName };
