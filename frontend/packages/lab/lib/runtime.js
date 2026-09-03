"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeBroker = exports.CourseWeaveRelayClient = void 0;
exports.createCourseWeaveIframe = createCourseWeaveIframe;
const coreutils_1 = require("@jupyterlab/coreutils");
const services_1 = require("@jupyterlab/services");
const protocol_1 = require("./protocol");
class CourseWeaveRelayClient {
    constructor(serviceOrigin, serverSettings = services_1.ServerConnection.makeSettings()) {
        this.serviceOrigin = serviceOrigin;
        this.serverSettings = serverSettings;
    }
    request(path, init) {
        const url = coreutils_1.URLExt.join(this.serverSettings.baseUrl, 'courseweave', path);
        return services_1.ServerConnection.makeRequest(url, { ...init, cache: 'default' }, this.serverSettings);
    }
    async getRuntime(runtimeId) {
        try {
            if (runtimeId.length === 0 || runtimeId.length > 240 || runtimeId.trim() !== runtimeId) {
                throw new Error('invalid runtime ID');
            }
            const response = await this.request('runtime', {
                method: 'GET',
                headers: { 'X-CourseWeave-Runtime-ID': runtimeId }
            });
            if (!response.ok)
                throw new Error('runtime relay failed');
            const payload = (0, protocol_1.parseRuntimeRelayPayload)(await response.json(), this.serviceOrigin);
            if (payload === null)
                throw new Error('invalid runtime relay payload');
            return payload;
        }
        catch {
            throw new Error('CourseWeave runtime unavailable.');
        }
    }
    async getCourse() {
        return this.request('course', { method: 'GET' });
    }
    async postContext(context) {
        return this.request('context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(context)
        });
    }
}
exports.CourseWeaveRelayClient = CourseWeaveRelayClient;
class RuntimeBroker {
    constructor(options) {
        this.options = options;
        this.listening = false;
        this.inFlight = false;
        this.listener = (event) => {
            const childWindow = this.options.iframe.contentWindow;
            if (!this.listening
                || this.inFlight
                || childWindow === null
                || event.source !== childWindow
                || event.origin !== this.options.serviceOrigin
                || (0, protocol_1.parseRuntimeRequest)(event.data) === null)
                return;
            this.inFlight = true;
            void this.reply(childWindow).finally(() => {
                this.inFlight = false;
            });
        };
    }
    async reply(childWindow) {
        try {
            const runtime = await this.options.relay.getRuntime(this.options.runtimeId);
            if (!this.listening
                || this.options.iframe.contentWindow !== childWindow
                || runtime.serviceOrigin !== this.options.serviceOrigin)
                return;
            this.options.beforeReply?.(childWindow);
            if (!this.listening || this.options.iframe.contentWindow !== childWindow)
                return;
            childWindow.postMessage({
                type: 'courseweave.runtime.v1',
                serviceOrigin: runtime.serviceOrigin,
                capabilityToken: runtime.capabilityToken,
                sourceId: this.options.sourceId
            }, this.options.serviceOrigin);
        }
        catch {
            // The guide already owns recovery UI. Never echo relay errors or secrets.
        }
    }
    start() {
        if (this.listening)
            return;
        this.listening = true;
        this.options.hostWindow.addEventListener('message', this.listener);
    }
    dispose() {
        if (!this.listening)
            return;
        this.listening = false;
        this.options.hostWindow.removeEventListener('message', this.listener);
    }
}
exports.RuntimeBroker = RuntimeBroker;
function createCourseWeaveIframe(serviceOrigin, mode) {
    const iframe = document.createElement('iframe');
    iframe.className = 'cw-Guide-iframe';
    iframe.title = mode === 'learn' ? 'CourseWeave guide' : 'CourseWeave author';
    iframe.src = `${serviceOrigin}/${mode}/`;
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    iframe.referrerPolicy = 'origin';
    return iframe;
}
