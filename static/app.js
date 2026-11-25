/* OnCall Command Center — Vue 3 应用
 * 模板使用 <script type="text/x-template"> 定义于本文件，编译由 vue.global 提供
 * 依赖: vue.global.prod, marked, highlight.js
 */
'use strict';

/* ============ 工具函数 ============ */
function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function fmtTime(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

function initMarkdown() {
    if (typeof marked === 'undefined') return;
    marked.setOptions({ breaks: true, gfm: true, headerIds: false, mangle: false });
}

function renderMarkdown(content) {
    if (!content) return '';
    if (typeof marked === 'undefined') return escapeHtml(content);
    try { return marked.parse(content); }
    catch (e) { console.error('Markdown 渲染失败:', e); return escapeHtml(content); }
}

function highlightBlocks(el) {
    if (typeof hljs === 'undefined' || !el) return;
    try {
        el.querySelectorAll('pre code').forEach(b => {
            if (!b.classList.contains('hljs')) hljs.highlightElement(b);
        });
    } catch (e) { console.error('代码高亮失败:', e); }
}

function generateSessionId() {
    return 'session_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now();
}

/* SSE 行解析器：把 chunk 按 \n 分行，yield data: 前缀的 payload
 * 返回 {done, event, data} 结构；调用方保持 buffer 逻辑 */
async function* sseLines(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) yield line;
    }
}

/* ============ API 封装 ============ */
const API = {
    base: '/api',
    async health() {
        // health 挂载在根路径（无 /api 前缀）
        const r = await fetch('/health');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    },
    async chat(sessionId, question) {
        const r = await fetch(`${API.base}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Id: sessionId, Question: question })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    },
    async chatStream(sessionId, question, handlers) {
        const r = await fetch(`${API.base}/chat_stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Id: sessionId, Question: question })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader();
        try {
            for await (const line of sseLines(reader)) {
                if (!line.startsWith('data:')) continue;
                const raw = line.substring(5).trim();
                if (raw === '[DONE]') { handlers.onDone && handlers.onDone(); return; }
                let msg;
                try { msg = JSON.parse(raw); } catch {
                    // 兼容非 JSON 载荷：当纯文本处理
                    handlers.onContent && handlers.onContent(raw);
                    continue;
                }
                if (msg && typeof msg.type === 'string') {
                    switch (msg.type) {
                        case 'content': handlers.onContent && handlers.onContent(msg.data || ''); break;
                        case 'tool_call': handlers.onToolCall && handlers.onToolCall(msg.data); break;
                        case 'search_results': handlers.onSearchResults && handlers.onSearchResults(msg.data); break;
                        case 'debug': break;
                        case 'done': handlers.onDone && handlers.onDone(msg.data); return;
                        case 'error': handlers.onError && handlers.onError(msg.data || '未知错误'); return;
                    }
                } else {
                    handlers.onContent && handlers.onContent(raw);
                }
            }
            handlers.onDone && handlers.onDone();
        } finally {
            reader.releaseLock();
        }
    },
    async aiops(sessionId, handlers) {
        const r = await fetch(`${API.base}/aiops`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const reader = r.body.getReader();
        try {
            for await (const line of sseLines(reader)) {
                if (!line.startsWith('data:')) continue;
                const raw = line.substring(5).trim();
                if (!raw || raw === '[DONE]') continue;
                let msg;
                try { msg = JSON.parse(raw); } catch { continue; }
                if (msg && typeof msg.type === 'string') {
                    const stop = handlers.onEvent ? handlers.onEvent(msg) : false;
                    if (stop) return;
                    if (msg.type === 'complete' || msg.type === 'error') return;
                }
            }
        } finally {
            reader.releaseLock();
        }
    },
    async upload(file) {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch(`${API.base}/upload`, { method: 'POST', body: fd });
        if (!r.ok) {
            let detail = `HTTP ${r.status}`;
            try { const j = await r.json(); if (j.detail) detail = j.detail; } catch {}
            throw new Error(detail);
        }
        return r.json();
    },
    async loadBackendSession(sessionId) {
        try {
            const r = await fetch(`${API.base}/chat/session/${sessionId}`);
            if (!r.ok) return null;
            const j = await r.json();
            return j.history || null;
        } catch { return null; }
    },
    async clearSession(sessionId) {
        const r = await fetch(`${API.base}/chat/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId })
        });
        if (!r.ok) throw new Error('清空会话失败');
        return r.json();
    }
};

/* ============ 常量 ============ */
const MODE_NAMES = { quick: '快速响应', stream: '流式推理' };
const QUICK_COMMANDS = [
    { icon: 'book', label: '知识库检索', text: '帮我检索一下告警处理的常用方案' },
    { icon: 'alert', label: '告警分析', text: 'CPU 使用率过高应该怎么排查？' },
    { icon: 'terminal', label: '日志诊断', text: '服务 5xx 错误率上升，从哪些日志入手？' },
    { icon: 'doc', label: '运维规范', text: '线上故障的升级流程是什么？' }
];

/* ============ Markdown 渲染组件（v-html + 高亮 + 自动滚动） ============ */
const MarkdownView = {
    name: 'MarkdownView',
    props: { content: { type: String, default: '' } },
    data() { return { html: '' }; },
    watch: {
        content: {
            immediate: true,
            handler(v) {
                this.html = renderMarkdown(v);
                this.$nextTick(() => { if (this.$refs.box) highlightBlocks(this.$refs.box); });
            }
        }
    },
    template: `
    <div class="md-body" ref="box" v-html="html"></div>
    `
};

/* ============ 诊断时间线组件（AIOps） ============ */
const DiagTimeline = {
    name: 'DiagTimeline',
    props: {
        events: { type: Array, default: () => [] },
        active: { type: Boolean, default: false }
    },
    methods: {
        iconFor(e) {
            switch (e.type) {
                case 'plan': return 'plan';
                case 'status': return 'pulse';
                case 'step_complete': return 'check';
                case 'report': return 'report';
                case 'complete': return 'flag';
                case 'error': return 'alert';
                default: return 'dot';
            }
        }
    },
    template: `
    <div class="diag-timeline" :class="{ 'is-running': active }">
        <div v-for="(e, i) in events" :key="i" class="tl-item" :class="'tl-' + e.type">
            <div class="tl-node">
                <svg v-if="e.type === 'plan'" viewBox="0 0 24 24"><path d="M4 5h16M4 12h10M4 19h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                <svg v-else-if="e.type === 'check' || e.type === 'step_complete'" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <svg v-else-if="e.type === 'report'" viewBox="0 0 24 24"><path d="M12 5v14M5 5h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" transform="rotate(45 12 12)"/><rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" stroke-width="2" fill="none" transform="rotate(45 12 12)"/></svg>
                <svg v-else-if="e.type === 'complete'" viewBox="0 0 24 24"><path d="M5 12l4 4L19 6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <svg v-else-if="e.type === 'error'" viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.01" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>
                <svg v-else viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>
            </div>
            <div class="tl-body">
                <div class="tl-label">{{ e.label }}</div>
                <div v-if="e.text" class="tl-text">{{ e.text }}</div>
                <ul v-if="e.items && e.items.length" class="tl-steps">
                    <li v-for="(s, j) in e.items" :key="j">{{ s }}</li>
                </ul>
            </div>
        </div>
        <div v-if="active" class="tl-item tl-running">
            <div class="tl-node tl-spin">
                <svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>
            </div>
            <div class="tl-body">
                <div class="tl-label running-label">诊断执行中<span class="dot-anim"><i></i><i></i><i></i></span></div>
            </div>
        </div>
    </div>
    `
};

/* ============ 根组件 ============ */
const App = {
    name: 'OnCallApp',
    components: { MarkdownView, DiagTimeline },
    setup() {
        const { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } = Vue;

        /* ---- 状态 ---- */
        const messages = ref([]);          // {id, role:'user'|'bot', content, type:'chat'|'aiops', ts, timeline?, streaming?}
        const inputText = ref('');
        const currentMode = ref('quick');
        const isBusy = ref(false);
        const sessionId = ref(generateSessionId());
        const fromHistory = ref(false);

        const chatHistories = ref(loadHistories());
        const notifications = reactive([]);
        const notifSeq = ref(0);

        const clock = ref('');
        const health = reactive({ state: 'unknown', milvus: 'unknown', version: '', lastCheck: '' });

        const overlay = reactive({ show: false, title: '', sub: '' });
        const modeMenuOpen = ref(false);
        const toolsMenuOpen = ref(false);
        const fileInputEl = ref(null);

        const msgListEl = ref(null);

        /* ---- 计算属性 ---- */
        const hasMessages = computed(() => messages.value.length > 0);
        const modeName = computed(() => MODE_NAMES[currentMode.value] || '快速响应');
        const healthDotClass = computed(() => {
            if (health.state === 'healthy') return 'ok';
            if (health.state === 'unhealthy') return 'down';
            return 'unknown';
        });
        const healthLabel = computed(() => {
            if (health.state === 'healthy') return '系统正常';
            if (health.state === 'unhealthy') return '服务异常';
            return '检测中…';
        });

        /* ---- 通知 ---- */
        function notify(message, type = 'info') {
            const id = ++notifSeq.value;
            notifications.push({ id, message, type });
            setTimeout(() => {
                const idx = notifications.findIndex(n => n.id === id);
                if (idx !== -1) notifications.splice(idx, 1);
            }, 3200);
        }

        /* ---- localStorage 历史 ---- */
        function loadHistories() {
            try {
                const s = localStorage.getItem('chatHistories');
                return s ? JSON.parse(s) : [];
            } catch (e) { console.error('加载历史对话失败:', e); return []; }
        }
        function saveHistories() {
            try { localStorage.setItem('chatHistories', JSON.stringify(chatHistories.value)); }
            catch (e) { console.error('保存历史对话失败:', e); }
        }
        function persistCurrentChat() {
            if (!messages.value.length) return;
            const firstUser = messages.value.find(m => m.role === 'user');
            const title = firstUser
                ? firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? '…' : '')
                : '新会话';
            const snapshot = messages.value
                .filter(m => m.role === 'user' || (m.role === 'bot' && m.content))
                .map(m => ({ type: m.role === 'bot' ? 'assistant' : 'user', content: m.content, timestamp: m.ts }));
            const idx = chatHistories.value.findIndex(h => h.id === sessionId.value);
            if (idx === -1) {
                chatHistories.value.unshift({ id: sessionId.value, title, messages: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
                if (chatHistories.value.length > 50) chatHistories.value = chatHistories.value.slice(0, 50);
            } else {
                const h = chatHistories.value[idx];
                h.title = title;
                h.messages = snapshot;
                h.updatedAt = new Date().toISOString();
            }
            saveHistories();
        }

        /* ---- 滚动 ---- */
        function scrollToBottom(force) {
            nextTick(() => {
                if (msgListEl.value) msgListEl.value.scrollTop = msgListEl.value.scrollHeight;
            });
        }

        /* ---- 消息构造 ---- */
        function pushMessage(m) {
            const msg = Object.assign({ id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString() }, m);
            messages.value.push(msg);
            scrollToBottom();
            return msg;
        }

        function currentHistorySnapshot() {
            return messages.value
                .filter(m => m.role === 'user' || (m.role === 'bot' && m.content))
                .map(m => ({ type: m.role === 'bot' ? 'assistant' : 'user', content: m.content, timestamp: m.ts }));
        }

        /* ---- 时钟 ---- */
        let clockTimer = null;
        function tickClock() {
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            clock.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }

        /* ---- 健康检查 ---- */
        let healthTimer = null;
        async function checkHealth() {
            try {
                const j = await API.health();
                const d = j && j.data;
                if (j && j.code === 200) {
                    health.state = 'healthy';
                } else {
                    health.state = 'unhealthy';
                }
                health.milvus = d && d.milvus ? d.milvus.status : 'unknown';
                health.version = d && d.version ? d.version : '';
                health.lastCheck = new Date().toLocaleTimeString('zh-CN');
            } catch {
                health.state = 'unhealthy';
                health.milvus = 'unknown';
                health.lastCheck = new Date().toLocaleTimeString('zh-CN');
            }
        }

        /* ---- 发送（快速/流式） ---- */
        async function sendMessage() {
            const text = inputText.value.trim();
            if (!text) { notify('请输入指令内容', 'warning'); return; }
            if (isBusy.value) { notify('请等待当前任务完成', 'warning'); return; }

            if (fromHistory.value) { /* 继续在历史会话中追加 */ }

            pushMessage({ role: 'user', content: text });
            inputText.value = '';
            isBusy.value = true;

            try {
                if (currentMode.value === 'quick') await sendQuick(text);
                else await sendStream(text);
            } catch (error) {
                console.error('发送消息失败:', error);
                pushMessage({ role: 'bot', content: '⚠️ 请求失败：' + (error && error.message ? error.message : String(error)) });
            } finally {
                isBusy.value = false;
                persistCurrentChat();
            }
        }

        async function sendQuick(text) {
            const loading = pushMessage({ role: 'bot', content: '', loading: true });
            try {
                const data = await API.chat(sessionId.value, text);
                if (data.code === 200 || data.message === 'success') {
                    const cr = data.data;
                    if (cr && cr.success) {
                        loading.loading = false;
                        loading.content = cr.answer || '（无回复内容）';
                    } else if (cr && cr.errorMessage) {
                        throw new Error(cr.errorMessage);
                    } else {
                        loading.loading = false;
                        loading.content = (cr && (cr.answer || cr.errorMessage)) || '服务返回了空内容';
                    }
                } else {
                    throw new Error(data.message || '请求失败');
                }
            } catch (e) {
                removeMessage(loading);
                throw e;
            }
        }

        function removeMessage(m) {
            const idx = messages.value.indexOf(m);
            if (idx !== -1) messages.value.splice(idx, 1);
        }

        async function sendStream(text) {
            const msg = pushMessage({ role: 'bot', content: '', streaming: true });
            let full = '';
            await API.chatStream(sessionId.value, text, {
                onContent(chunk) {
                    full += chunk;
                    msg.content = full;
                    scrollToBottom();
                },
                onToolCall(tc) {
                    if (tc && tc.tool) {
                        msg.toolCalls = msg.toolCalls || [];
                        msg.toolCalls.push({ tool: tc.tool, status: tc.status, ts: Date.now() });
                        scrollToBottom();
                    }
                },
                onDone() {
                    msg.streaming = false;
                    if (!full) msg.content = '（无回复内容）';
                },
                onError(errText) {
                    msg.streaming = false;
                    msg.content = '⚠️ 流式请求失败：' + errText;
                }
            });
            msg.streaming = false;
            if (!msg.content) msg.content = '（无回复内容）';
        }

        /* ---- AIOps 诊断 ---- */
        async function runDiagnosis() {
            if (isBusy.value) { notify('请等待当前任务完成', 'warning'); return; }

            // 开新会话再诊断（沿用旧行为：诊断在新会话中执行）
            persistIfNotEmpty();
            startNewChatInternal();

            const msg = pushMessage({
                role: 'bot', content: '', type: 'aiops',
                timeline: [], diagRunning: true
            });
            isBusy.value = true;

            const timeline = msg.timeline;

            const addEvent = (e) => {
                timeline.push(Object.assign({ key: 'e' + Date.now() + Math.random().toString(36).slice(2, 5) }, e));
                scrollToBottom();
            };

            try {
                await API.aiops(sessionId.value, {
                    onEvent(ev) {
                        switch (ev.type) {
                            case 'status':
                                addEvent({ type: 'status', label: '状态', text: ev.message || '' });
                                break;
                            case 'plan':
                                addEvent({
                                    type: 'plan', label: '诊断计划已生成',
                                    text: ev.message || '',
                                    items: Array.isArray(ev.plan) ? ev.plan : []
                                });
                                break;
                            case 'step_complete':
                                addEvent({
                                    type: 'step_complete', label: '步骤完成',
                                    text: ev.message || (ev.current_step || '')
                                });
                                break;
                            case 'report':
                                msg.content = ev.report || ev.message || '';
                                addEvent({ type: 'report', label: '诊断报告已生成', text: '' });
                                break;
                            case 'complete':
                                if (ev.response && !msg.content) msg.content = ev.response;
                                if (ev.diagnosis && !msg.content) msg.content = formatDiagnosis(ev.diagnosis);
                                addEvent({ type: 'complete', label: '诊断完成', text: '' });
                                return true;
                            case 'done':
                                addEvent({ type: 'complete', label: '诊断完成', text: '' });
                                return true;
                            case 'error':
                                addEvent({ type: 'error', label: '诊断失败', text: ev.message || ev.data || '未知错误' });
                                msg.content = '';
                                return true;
                        }
                        return false;
                    }
                });
            } catch (error) {
                console.error('智能运维分析失败:', error);
                addEvent({ type: 'error', label: '诊断失败', text: error.message || String(error) });
            } finally {
                msg.diagRunning = false;
                isBusy.value = false;
                persistCurrentChat();
                scrollToBottom();
            }
        }

        function formatDiagnosis(d) {
            if (!d) return '';
            if (typeof d === 'string') return d;
            try { return '```json\n' + JSON.stringify(d, null, 2) + '\n```'; }
            catch { return String(d); }
        }

        function persistIfNotEmpty() {
            if (messages.value.length && !fromHistory.value) persistCurrentChat();
            else if (messages.value.length && fromHistory.value) persistCurrentChat();
        }

        /* ---- 新会话 ---- */
        function startNewChatInternal() {
            messages.value = [];
            sessionId.value = generateSessionId();
            fromHistory.value = false;
            currentMode.value = 'quick';
        }
        function newChat() {
            if (isBusy.value) { notify('请等待当前任务完成后再新建会话', 'warning'); return; }
            if (messages.value.length) persistCurrentChat();
            startNewChatInternal();
        }

        /* ---- 历史会话 ---- */
        async function openHistory(h) {
            if (isBusy.value) { notify('请等待当前任务完成', 'warning'); return; }
            // 先保存当前
            if (messages.value.length && sessionId.value !== h.id) persistCurrentChat();

            sessionId.value = h.id;
            fromHistory.value = true;
            messages.value = [];

            const backend = await API.loadBackendSession(h.id);
            let source;
            if (backend && backend.length) {
                source = backend.map(m => ({ role: m.role === 'user' ? 'user' : 'bot', content: m.content, ts: m.timestamp }));
            } else {
                source = (h.messages || []).map(m => ({ role: m.type === 'user' ? 'user' : 'bot', content: m.content, ts: m.timestamp }));
            }
            source.forEach(s => pushMessage({ role: s.role, content: s.content, ts: s.ts || new Date().toISOString() }));
            scrollToBottom();
        }

        async function deleteHistory(h) {
            try {
                const result = await API.clearSession(h.id);
                if (result.status === 'success' || result.code === 200) {
                    chatHistories.value = chatHistories.value.filter(x => x.id !== h.id);
                    saveHistories();
                    if (sessionId.value === h.id) {
                        startNewChatInternal();
                    }
                    notify('会话已清除', 'success');
                } else {
                    throw new Error(result.message || '清空会话失败');
                }
            } catch (error) {
                console.error('删除历史对话失败:', error);
                notify('删除失败: ' + error.message, 'error');
            }
        }

        /* ---- 文件上传 ---- */
        function triggerUpload() {
            toolsMenuOpen.value = false;
            if (fileInputEl.value) fileInputEl.value.click();
        }
        function onFileChange(e) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const name = file.name.toLowerCase();
            if (!/(\.txt|\.md|\.markdown)$/.test(name)) {
                notify('只支持上传 TXT 或 Markdown (.md) 格式的文件', 'error');
                e.target.value = '';
                return;
            }
            if (file.size > 50 * 1024 * 1024) {
                notify('文件大小不能超过 50MB', 'error');
                e.target.value = '';
                return;
            }
            doUpload(file);
        }
        async function doUpload(file) {
            isBusy.value = true;
            overlay.show = true;
            overlay.title = '知识库索引构建中';
            overlay.sub = file.name;
            try {
                const data = await API.upload(file);
                if ((data.code === 200 || data.message === 'success') && data.data) {
                    pushMessage({ role: 'bot', content: `📄 **${file.name}** 已上传并完成向量索引，可以开始针对它提问了。` });
                } else {
                    throw new Error(data.message || '上传失败');
                }
            } catch (error) {
                notify('文件上传失败: ' + error.message, 'error');
            } finally {
                overlay.show = false;
                if (fileInputEl.value) fileInputEl.value.value = '';
                isBusy.value = false;
                persistCurrentChat();
            }
        }

        /* ---- 快捷指令 ---- */
        function useCommand(cmd) {
            if (isBusy.value) { notify('请等待当前任务完成', 'warning'); return; }
            inputText.value = cmd.text;
            sendMessage();
        }

        /* ---- 生命周期 ---- */
        onMounted(() => {
            initMarkdown();
            tickClock();
            clockTimer = setInterval(tickClock, 1000);
            checkHealth();
            healthTimer = setInterval(checkHealth, 30000);
        });
        onBeforeUnmount(() => {
            if (clockTimer) clearInterval(clockTimer);
            if (healthTimer) clearInterval(healthTimer);
        });

        return {
            messages, inputText, currentMode, isBusy, sessionId,
            chatHistories, notifications, clock, health, overlay,
            modeMenuOpen, toolsMenuOpen, fileInputEl, msgListEl,
            hasMessages, modeName, healthDotClass, healthLabel, QUICK_COMMANDS,
            sendMessage, newChat, runDiagnosis, openHistory, deleteHistory,
            triggerUpload, onFileChange, useCommand,
            fmtTime
        };
    },
    template: `
    <div class="app-shell">

        <!-- ========== 顶栏 ========== -->
        <header class="topbar">
            <div class="topbar-brand">
                <div class="brand-mark">
                    <svg viewBox="0 0 100 100">
                        <path d="M50 18 L58 42 L82 50 L58 58 L50 82 L42 58 L18 50 L42 42 Z" fill="currentColor"/>
                    </svg>
                </div>
                <div class="brand-text">
                    <div class="brand-name">OnCall <span>Command Center</span></div>
                    <div class="brand-sub">智能运维指挥中心 · RAG 知识问答 / AIOps 根因诊断</div>
                </div>
            </div>

            <div class="topbar-status">
                <div class="status-pill" :class="'pill-' + healthDotClass">
                    <span class="status-dot"></span>
                    <span class="status-label">{{ healthLabel }}</span>
                    <span class="status-meta" v-if="health.milvus === 'connected'">Milvus ✓</span>
                    <span class="status-meta warn" v-else-if="health.state === 'unhealthy'">Milvus ✕</span>
                </div>
                <div class="topbar-clock" title="当前时间">{{ clock }}</div>
            </div>
        </header>

        <div class="workspace">
            <!-- ========== 侧栏 ========== -->
            <aside class="sidebar">
                <button class="btn-new-session" @click="newChat">
                    <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                    <span>新建会话</span>
                </button>

                <button class="btn-diagnose" @click="runDiagnosis" :disabled="isBusy">
                    <svg viewBox="0 0 24 24"><path d="M3 12h4l2-7 4 14 2-7h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
                    <span>一键根因诊断</span>
                    <span class="btn-tag">AIOps</span>
                </button>

                <div class="sb-section">
                    <div class="sb-section-title">会话记录</div>
                    <div class="history-list">
                        <div v-if="!chatHistories.length" class="history-empty">暂无历史会话</div>
                        <div v-for="h in chatHistories" :key="h.id" class="history-item" :class="{ active: h.id === sessionId }" @click="openHistory(h)">
                            <svg class="hi-icon" viewBox="0 0 24 24"><path d="M4 5h16v14H8l-4 4V5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg>
                            <span class="hi-title">{{ h.title }}</span>
                            <button class="hi-delete" @click.stop="deleteHistory(h)" title="删除">
                                <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="sidebar-foot">
                    <div class="foot-row"><span>SESSION</span><code>{{ sessionId.slice(-10) }}</code></div>
                    <div class="foot-row"><span>ENGINE</span><code>LangGraph + RAG</code></div>
                </div>
            </aside>

            <!-- ========== 主区 ========== -->
            <main class="main-pane">
                <!-- 空状态：欢迎屏 -->
                <div v-if="!hasMessages" class="welcome">
                    <div class="welcome-grid-bg"></div>
                    <div class="welcome-inner">
                        <div class="welcome-eyebrow">SYSTEM READY</div>
                        <h1 class="welcome-title">有什么告警，直接说。</h1>
                        <p class="welcome-desc">知识库检索 · 日志分析 · 根因定位 —— 输入问题或触发一次自动诊断。</p>
                        <div class="cmd-grid">
                            <button v-for="c in QUICK_COMMANDS" :key="c.label" class="cmd-card" @click="useCommand(c)">
                                <div class="cmd-icon">
                                    <svg v-if="c.icon === 'book'" viewBox="0 0 24 24"><path d="M4 4h7v16H4zM13 4h7v16h-7z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg>
                                    <svg v-else-if="c.icon === 'alert'" viewBox="0 0 24 24"><path d="M12 3l10 18H2L12 3z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M12 10v5M12 17.5v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                                    <svg v-else-if="c.icon === 'terminal'" viewBox="0 0 24 24"><path d="M4 5h16v14H4z" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M7 9l3 3-3 3M12 15h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                                    <svg v-else viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6V2z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M15 2v5h5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>
                                </div>
                                <div class="cmd-text">
                                    <div class="cmd-label">{{ c.label }}</div>
                                    <div class="cmd-desc">{{ c.text }}</div>
                                </div>
                                <svg class="cmd-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 消息流 -->
                <div v-else class="msg-flow" ref="msgListEl">
                    <div v-for="m in messages" :key="m.id" class="msg" :class="[m.role === 'user' ? 'msg-user' : 'msg-bot', m.type === 'aiops' ? 'msg-aiops' : '']">

                        <!-- 用户消息 -->
                        <template v-if="m.role === 'user'">
                            <div class="bubble-user">
                                <div class="bubble-user-text">{{ m.content }}</div>
                            </div>
                            <div class="msg-meta user-meta">{{ fmtTime(m.ts) }}</div>
                        </template>

                        <!-- 助手消息 -->
                        <template v-else>
                            <div class="bot-avatar" :class="{ 'bot-avatar-aiops': m.type === 'aiops' }">
                                <svg viewBox="0 0 100 100"><path d="M50 18 L58 42 L82 50 L58 58 L50 82 L42 58 L18 50 L42 42 Z" fill="currentColor"/></svg>
                            </div>
                            <div class="bot-body">

                                <!-- 加载态 -->
                                <div v-if="m.loading" class="bubble-bot loading-bubble">
                                    <span class="thinking-label">推理中</span>
                                    <span class="dot-anim"><i></i><i></i><i></i></span>
                                </div>

                                <!-- AIOps 诊断卡片 -->
                                <template v-else-if="m.type === 'aiops'">
                                    <div class="diag-card">
                                        <div class="diag-card-head">
                                            <div class="diag-title">
                                                <span class="diag-badge">AIOps</span>
                                                <span>自动根因诊断</span>
                                                <span class="diag-state" v-if="m.diagRunning">RUNNING</span>
                                                <span class="diag-state done" v-else>FINISHED</span>
                                            </div>
                                        </div>
                                        <diag-timeline :events="m.timeline" :active="m.diagRunning"></diag-timeline>
                                        <div v-if="m.content" class="diag-report">
                                            <div class="diag-report-head">诊断报告</div>
                                            <markdown-view :content="m.content"></markdown-view>
                                        </div>
                                    </div>
                                </template>

                                <!-- 普通回复 -->
                                <div v-else class="bubble-bot" :class="{ 'is-streaming': m.streaming }">
                                    <markdown-view v-if="m.content" :content="m.content"></markdown-view>
                                    <span v-else-if="m.streaming" class="stream-cursor-row">
                                        <span class="dot-anim"><i></i><i></i><i></i></span>
                                    </span>
                                </div>

                                <div v-if="m.toolCalls && m.toolCalls.length" class="tool-strip">
                                    <span v-for="(t, i) in m.toolCalls" :key="i" class="tool-chip">
                                        <span class="tool-dot"></span>{{ t.tool }}
                                    </span>
                                </div>

                                <div class="msg-meta">{{ m.type === 'aiops' ? 'AIOps Agent' : 'RAG Agent' }} · {{ fmtTime(m.ts) }}</div>
                            </div>
                        </template>
                    </div>
                </div>

                <!-- ========== 输入区 ========== -->
                <div class="composer" :class="{ 'composer-raised': !hasMessages }">
                    <div class="composer-box">
                        <textarea
                            id="messageInput"
                            ref="inputFocus"
                            v-model="inputText"
                            :disabled="isBusy"
                            rows="1"
                            maxlength="1000"
                            placeholder="描述故障现象 / 提问知识库…"
                            @keydown.enter.exact.prevent="sendMessage()"
                        ></textarea>
                        <div class="composer-bar">
                            <div class="cb-left">
                                <button class="icon-btn" @click.stop="toolsMenuOpen = !toolsMenuOpen" title="工具">
                                    <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>
                                </button>
                                <transition name="pop">
                                    <div v-if="toolsMenuOpen" class="tools-pop">
                                        <button class="tools-pop-item" @click="triggerUpload">
                                            <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5l5 5M5 18h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
                                            <span>上传知识文档</span>
                                            <span class="tp-tag">.txt / .md</span>
                                        </button>
                                    </div>
                                </transition>
                            </div>
                            <div class="cb-right">
                                <button class="mode-btn" @click.stop="modeMenuOpen = !modeMenuOpen">
                                    <span class="mode-dot" :class="{ 'mode-dot-stream': currentMode === 'stream' }"></span>
                                    {{ modeName }}
                                    <svg class="chev" viewBox="0 0 24 24" :class="{ open: modeMenuOpen }"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
                                </button>
                                <transition name="pop">
                                    <div v-if="modeMenuOpen" class="mode-pop">
                                        <div class="mode-pop-head">推理模式</div>
                                        <button class="mode-pop-item" :class="{ active: currentMode === 'quick' }" @click="currentMode = 'quick'; modeMenuOpen = false">
                                            <span class="mpi-dot"></span>
                                            <div class="mpi-text">
                                                <div class="mpi-name">快速响应</div>
                                                <div class="mpi-desc">一次性返回完整答案</div>
                                            </div>
                                        </button>
                                        <button class="mode-pop-item" :class="{ active: currentMode === 'stream' }" @click="currentMode = 'stream'; modeMenuOpen = false">
                                            <span class="mpi-dot stream"></span>
                                            <div class="mpi-text">
                                                <div class="mpi-name">流式推理</div>
                                                <div class="mpi-desc">逐字输出，实时感知思考过程</div>
                                            </div>
                                        </button>
                                    </div>
                                </transition>
                                <button class="send-btn" :disabled="isBusy || !inputText.trim()" @click="sendMessage()" title="发送 (Enter)">
                                    <svg viewBox="0 0 24 24"><path d="M4 12L20 4l-6 16-2.5-6.5L4 12z" fill="currentColor"/></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="composer-hint">Enter 发送 · Shift+Enter 换行 ·内容由 AI 生成，请结合监控与日志复核</div>
                </div>
            </main>
        </div>

        <!-- ========== 上传遮罩 ========== -->
        <transition name="fade">
            <div v-if="overlay.show" class="overlay">
                <div class="overlay-card">
                    <div class="overlay-ring">
                        <svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" fill="none" stroke-width="5"/></svg>
                    </div>
                    <div class="overlay-title">{{ overlay.title }}</div>
                    <div class="overlay-sub">{{ overlay.sub }}</div>
                </div>
            </div>
        </transition>

        <!-- ========== 通知 ========== -->
        <transition-group name="toast" tag="div" class="toast-area">
            <div v-for="n in notifications" :key="n.id" class="toast" :class="'toast-' + n.type">
                <span class="toast-dot"></span>{{ n.message }}
            </div>
        </transition-group>

        <input type="file" ref="fileInputEl" accept=".txt,.md,.markdown" style="display:none" @change="onFileChange">
    </div>
    `
};

/* ============ 挂载 ============ */
initMarkdown();
const app = Vue.createApp(App);
app.mount('#app');
