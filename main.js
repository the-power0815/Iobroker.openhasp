
'use strict';
const utils = require('@iobroker/adapter-core');
const mqtt = require('mqtt');

class OpenHASP extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'openhasp' });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.mqttClient = null; this.connected = false; this.suffixCache = new Map();
  }

  _coerceBool(v, def=false) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true') return true; if (s === 'false') return false;
    }
    return def;
  }

  _readConfigTolerant(native) {
    const n = native || {};
    const hasNumeric = (i) => (n[String(i)] !== undefined && n[String(i)] !== null && n[String(i)] !== '');
    const getNum = (i, def) => hasNumeric(i) ? n[String(i)] : def;

    const mqttHost = String(getNum(1, (typeof n.mqttHost === 'string' && n.mqttHost) ? n.mqttHost : '127.0.0.1'));
    const mqttPort = Number(getNum(2, (typeof n.mqttPort === 'number') ? n.mqttPort : (typeof n.mqttPort === 'string' && n.mqttPort.trim() ? Number(n.mqttPort) : 1883)));
    const mqttUser = String(getNum(3, (typeof n.mqttUser === 'string') ? n.mqttUser : ''));
    const mqttPassword = String(getNum(4, (typeof n.mqttPassword === 'string') ? n.mqttPassword : ''));
    const mqttBaseTopic = String(getNum(5, (typeof n.mqttBaseTopic === 'string') ? n.mqttBaseTopic : 'hasp')).replace(/\/$/, '');
    const useTLS = this._coerceBool(getNum(6, (n.mqttUseTLS !== undefined) ? n.mqttUseTLS : n.useTLS), false);

    return { mqttHost, mqttPort, mqttUser, mqttPassword, mqttBaseTopic, useTLS };
  }

  async _migrateExistingStatesToString() {
    try {
      const objs = await this.getAdapterObjectsAsync();
      for (const [id, obj] of Object.entries(objs)) {
        if (!obj || obj.type !== 'state') continue;
        // Ignore internal states like info.connection and *_suffix states handled below
        const rel = id.startsWith(this.namespace + '.') ? id.substring(this.namespace.length + 1) : '';
        if (!rel) continue;
        const parts = rel.split('.');
        if (parts.length < 2) continue; // expect <plate>.<dp> or <plate>.<dp>_suffix
        const dp = parts[1];
        if (dp && !dp.endsWith('_suffix')) {
          const common = obj.common || {};
          let changed = false;
          if (common.type !== 'string') { common.type = 'string'; changed = true; }
          if (!common.role || common.role === 'state') { common.role = 'text'; changed = true; }
          if (changed) {
            await this.extendObjectAsync(id, { common });
            this.log.warn(`Migrated state to string: ${id}`);
          }
        } else if (dp && dp.endsWith('_suffix')) {
          const common = obj.common || {};
          let changed = false;
          if (common.type !== 'string') { common.type = 'string'; changed = true; }
          if (!common.role || common.role === 'state') { common.role = 'text'; changed = true; }
          if (changed) {
            await this.extendObjectAsync(id, { common });
            this.log.warn(`Migrated suffix state to string: ${id}`);
          }
        }
      }
    } catch (e) {
      this.log.warn(`State migration to string failed: ${e.message}`);
    }
  }

  async onReady() {
    try {
      this.log.info('openHASP adapter starting (v2.1.16) – string state enforcement');

      // Create system state early
      await this.setObjectNotExistsAsync('info.connection', { type: 'state', common: { name: 'Connection', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false }, native: {} });
      await this.setStateAsync('info.connection', false, true);

      // Read config
      const instId = `system.adapter.${this.namespace}`;
      const obj = await this.getForeignObjectAsync(instId);
      const cfg = this._readConfigTolerant((obj && obj.native) || {});
      this.log.info(`Config: host=${cfg.mqttHost}, port=${cfg.mqttPort}, user=${cfg.mqttUser || '(none)'}, base='${cfg.mqttBaseTopic}', tls=${cfg.useTLS}`);

      // Subscribe states (needed for onStateChange)
      this.subscribeStates('*');

      // Enforce type=string on existing states
      await this._migrateExistingStatesToString();

      // Connect MQTT
      this.baseTopic = cfg.mqttBaseTopic;
      const url = `${cfg.useTLS ? 'mqtts' : 'mqtt'}://${cfg.mqttHost}:${cfg.mqttPort}`;
      const options = { clean: true, reconnectPeriod: 2000 };
      if (cfg.mqttUser) options.username = cfg.mqttUser;
      if (cfg.mqttPassword) options.password = cfg.mqttPassword;

      this.log.info(`Connecting to MQTT ${url} (baseTopic='${cfg.mqttBaseTopic}') ...`);
      this.mqttClient = mqtt.connect(url, options);

      this.mqttClient.on('connect', () => {
        this.connected = true; this.setState('info.connection', true, true);
        const sub = `${cfg.mqttBaseTopic}/+/state/#`;
        this.mqttClient.subscribe(sub, { qos: 0 }, err => {
          if (err) this.log.error(`MQTT subscribe error: ${err.message}`); else this.log.info(`Subscribed: ${sub}`);
        });
      });
      this.mqttClient.on('reconnect', () => this.log.debug('MQTT reconnecting...'));
      this.mqttClient.on('close', () => { this.connected = false; this.setState('info.connection', false, true); });
      this.mqttClient.on('error', err => this.log.error(`MQTT error: ${err.message}`));
      this.mqttClient.on('message', (topic, buf) => { try { this.handleIncoming(topic, buf.toString()); } catch (e) { this.log.warn(`Failed to handle message '${topic}': ${e.message}`); } });

      this.log.info('openHASP adapter ready.');
    } catch (e) { this.log.error(`onReady fatal error: ${e.stack || e.message}`); }
  }

  // Strict DOT topic builder; removes any '/' in dp & suffix (for topic only)
  buildCommandTopic(baseTopic, plate, dpName, suffix) {
    let cleanDp = String(dpName ?? '').trim();
    cleanDp = cleanDp.replace(/[\/+]+$/, '').replace(/\//g, '');
    let cleanSuffix = String(suffix ?? '').trim();
    cleanSuffix = cleanSuffix.replace(/^\.+/, '').replace(/\//g, '');
    return `${baseTopic}/${plate}/command/${cleanDp}${cleanSuffix ? '.' + cleanSuffix : ''}`;
  }

  async _getSuffix(plate, dp) {
    const key = `${plate}|${dp}`;
    let suffix = this.suffixCache.get(key);
    if (suffix === undefined) {
      const s = await this.getStateAsync(`${plate}.${dp}_suffix`);
      suffix = s && s.val != null ? String(s.val) : 'val';
      this.suffixCache.set(key, suffix);
    }
    return String(suffix);
  }

  async onStateChange(id, state) {
    try {
      this.log.debug(`onStateChange: ${id} = ${state ? JSON.stringify(state.val) : 'null'} (ack=${state && state.ack})`);
      if (!state) return; // deleted
      if (state.ack) return; // only manual/script writes
      if (!id.startsWith(this.namespace + '.')) return;

      const rel = id.substring(this.namespace.length + 1); // plate.dp or plate.dp_suffix
      const parts = rel.split('.');
      if (parts.length < 2) return;

      const plate = parts[0];
      let dp = parts[1];

      // suffix state update
      if (dp.endsWith('_suffix')) {
        const realDp = dp.slice(0, -7);
        const suffixVal = String(state.val ?? '').trim();
        this.suffixCache.set(`${plate}|${realDp}`, suffixVal);
        await this.setStateAsync(id, { val: suffixVal, ack: true });
        this.log.debug(`Suffix updated [${plate}/${realDp}] -> '${suffixVal}'`);
        return;
      }

      const suffix = await this._getSuffix(plate, dp);
      const topic = this.buildCommandTopic(this.baseTopic, plate, dp, suffix);
      const payload = String(state.val);

      this.log.debug(`Publish intent: topic='${topic}' (suffix='${suffix}'), payloadLength=${payload.length}`);

      if (this.mqttClient && this.connected) {
        this.mqttClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
          if (err) this.log.error(`MQTT publish error: ${err.message}`);
          else this.log.debug(`Published '${topic}' => '${payload}'`);
        });
      } else {
        this.log.warn('MQTT not connected, cannot publish');
      }

      await this.setStateAsync(id, { val: String(state.val), ack: true });
    } catch (e) {
      this.log.error(`onStateChange error: ${e.stack || e.message}`);
    }
  }

  parseStateTopic(topic) {
    const parts = topic.split('/'); if (parts.length < 4) return null;
    const [base, plate, section, rest] = [parts[0], parts[1], parts[2], parts.slice(3).join('/')];
    if (base !== this.baseTopic || section !== 'state') return null;

    let dp = rest; let attr = '';
    if (rest.includes('/')) { const idx = rest.lastIndexOf('/'); dp = rest.substring(0, idx); attr = rest.substring(idx + 1); }
    if (!attr && dp.includes('.')) { const idx = dp.lastIndexOf('.'); attr = dp.substring(idx + 1); dp = dp.substring(0, idx); }

    dp = String(dp).trim().replace(/\.+$/, '');
    attr = String(attr).trim().replace(/^\.+/, '');

    return { plate, dp, attr };
  }

  async ensureDpObjects(plate, dp) {
    const channelId = `${plate}`;
    const dpId = `${channelId}.${dp}`;
    const suffixId = `${dpId}_suffix`;

    await this.setObjectNotExistsAsync(channelId, { type: 'channel', common: { name: plate }, native: {} });
    await this.setObjectNotExistsAsync(dpId, { type: 'state', common: { name: dp, type: 'string', role: 'text', read: true, write: true, def: '' }, native: {} });
    await this.setObjectNotExistsAsync(suffixId, { type: 'state', common: { name: `${dp} suffix`, type: 'string', role: 'text', read: true, write: true, def: 'val' }, native: {} });

    const s = await this.getStateAsync(suffixId);
    const suffix = s && s.val != null ? String(s.val) : 'val';
    this.suffixCache.set(`${plate}|${dp}`, suffix);
  }

  async handleIncoming(topic, payload) {
    const parsed = this.parseStateTopic(topic);
    if (!parsed) return;

    const { plate, dp, attr } = parsed;
    if (!dp) return;

    await this.ensureDpObjects(plate, dp);

    const key = `${plate}|${dp}`;
    const currentSuffix = (this.suffixCache.get(key) || 'val').replace(/^\.+/, '');

    if (!attr || attr === currentSuffix) {
      await this.setStateAsync(`${plate}.${dp}`, { val: String(payload), ack: true });
    }
  }

  onUnload(cb) { try { if (this.mqttClient) { this.mqttClient.end(true); this.mqttClient = null; } cb(); } catch (e) { cb(); } }
}

if (module.parent) { module.exports = (options) => new OpenHASP(options); } else { new OpenHASP(); }
