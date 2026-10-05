/* The terminal is scoped to one node and one socket generation. */
class CitadelSshTerminal {
  constructor(api) {
    this.api = api;
    this.epoch = 0;
    this.socket = null;
    this.terminal = null;
    this.nodeId = '';
    this.ready = false;
    this.connecting = false;
    this.canConnect = false;
    this.elements = Object.fromEntries(['sshNodeSelect', 'sshStatus', 'sshTerminal', 'sshConnect', 'sshDisconnect']
      .map(id => [id, document.getElementById(id)]));
    this.elements.sshNodeSelect.addEventListener('change', () => this.select(this.elements.sshNodeSelect.value));
    this.elements.sshConnect.addEventListener('click', () => this.connect());
    this.elements.sshDisconnect.addEventListener('click', () => this.disconnect('Сеанс отключён.'));
  }
  status(message) {this.elements.sshStatus.textContent = message;}
  buttons() {
    this.elements.sshConnect.disabled = !this.canConnect || this.connecting || Boolean(this.socket);
    this.elements.sshDisconnect.disabled = !this.socket;
    if (this.terminal) this.terminal.options.disableStdin = !this.ready;
  }
  open(nodes, nodeId) {
    this.close();
    const select = this.elements.sshNodeSelect;
    select.replaceChildren();
    for (const node of nodes.filter(n => n.status !== 'revoked')) {
      const option = document.createElement('option');
      option.value = node.node_id; option.textContent = node.hostname || node.node_id;
      select.append(option);
    }
    select.value = nodeId;
    this.terminal = new Terminal({cursorBlink: true, disableStdin: true, convertEol: false,
      fontSize: 14, scrollback: 2000, theme: {background: '#071018', foreground: '#d6e8ee'}});
    this.fit = new FitAddon.FitAddon(); this.terminal.loadAddon(this.fit);
    this.terminal.open(this.elements.sshTerminal);
    this.terminal.onData(data => {
      if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(data);
      if (bytes.length > 65536 || this.socket.bufferedAmount > 65536) return this.disconnect('Слишком большой объём ввода. Подключитесь заново.');
      for (let start = 0; start < bytes.length; start += 8192) this.socket.send(bytes.slice(start, start + 8192));
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.elements.sshTerminal);
    this.select(select.value);
  }
  async select(nodeId) {
    this.disconnect(); this.nodeId = nodeId; this.canConnect = false; this.buttons();
    const epoch = this.epoch;
    this.terminal?.reset();
    if (!nodeId) return this.status('Выберите узел.');
    this.status('Проверяю возможность подключения…');
    try {
      const state = await this.api('/nodes/' + encodeURIComponent(nodeId) + '/ssh/session');
      if (epoch !== this.epoch || nodeId !== this.nodeId) return;
      this.canConnect = state.can_connect === true;
      this.status(!state.configured ? 'Интерактивный SSH ещё не настроен администратором.' :
        !this.canConnect && state.agent_connected === false && !state.gateway_configured
          ? 'Агент узла ещё не подключился к SSH-каналу.' :
        !this.canConnect ? 'Для SSH требуется доступ владельца.' :
        state.agent_connected ? 'Агент узла подключён. Можно открыть SSH.' : 'Шлюз настроен. Доступность SSH узла проверится при подключении.');
      this.buttons();
    } catch (error) {if (epoch === this.epoch) this.status('Подключение недоступно: ' + error.message);}
  }
  resize() {
    if (!this.terminal) return;
    this.fit.fit();
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({type: 'resize',
      cols: Math.max(20, Math.min(300, this.terminal.cols)), rows: Math.max(5, Math.min(150, this.terminal.rows))}));
  }
  async connect() {
    if (!this.canConnect || this.socket || !this.nodeId) return;
    this.connecting = true; this.buttons();
    const nodeId = this.nodeId, epoch = ++this.epoch;
    this.status('Подключаюсь…'); this.terminal.reset();
    let failed = false, pendingOutput = 0;
    try {
      const session = await this.api('/nodes/' + encodeURIComponent(nodeId) + '/ssh/session', {method: 'POST', body: '{}'});
      if (epoch !== this.epoch || nodeId !== this.nodeId) return;
      const url = new URL(session.websocket_path, location.origin);
      if (url.origin !== location.origin || !['/api/v1/architect/ssh/connect', '/api/v1/architect/ssh/relay/connect'].includes(url.pathname)) throw Error('invalid_ssh_endpoint');
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, ['citadel-ssh-v1', 'ticket.' + session.ticket]);
      socket.binaryType = 'arraybuffer'; this.socket = socket; this.buttons();
      socket.onmessage = event => {
        if (epoch !== this.epoch || nodeId !== this.nodeId) return;
        if (event.data instanceof ArrayBuffer) {
          pendingOutput += event.data.byteLength;
          if (pendingOutput > 2 * 1024 * 1024) return this.disconnect('Вывод превышает скорость терминала.');
          const terminal = this.terminal, bytes = new Uint8Array(event.data);
          terminal.write(bytes, () => {pendingOutput -= bytes.byteLength;});
          return;
        }
        let message;
        try {message = JSON.parse(event.data);} catch {return this.disconnect('Некорректный ответ SSH.');}
        if (message.type === 'ready') {
          if (message.node_id !== nodeId) return this.disconnect('Ответ относится к другому узлу.');
          this.ready = true; this.buttons(); this.resize(); this.terminal.focus();
          this.status(message.mode === 'managed_admin' ? 'SSH подключён · citadel-admin (administrator).' :
            message.mode === 'restricted_fallback' ? 'SSH подключён · ограниченный fallback.' : 'SSH подключён.');
        } else if (message.type === 'error') {
          failed = true;
          const errors = {ssh_target_not_configured: 'SSH для этого узла ещё не настроен.',
            ssh_connection_failed: 'Не удалось подключиться к SSH хоста. Проверьте адрес, ключ и fingerprint.',
            session_expired: 'Время сеанса истекло.', session_idle_timeout: 'Сеанс закрыт из-за отсутствия ввода.',
            ssh_shell_unavailable: 'Хост не разрешил интерактивный терминал.',
            ssh_restricted_console_required: 'Отклонено: на хосте не подтверждена CITADEL Restricted SSH Console.'};
          this.status(errors[message.code] || 'SSH-сеанс завершён: ' + message.code);
        } else if (message.type === 'exit') {failed = true; this.status('SSH завершён' + (message.code === null ? '.' : ' · код ' + message.code));}
      };
      socket.onerror = () => {if (epoch === this.epoch) {failed = true; this.status('SSH-соединение недоступно. Попробуйте подключиться заново.');}};
      socket.onclose = () => {
        if (epoch !== this.epoch) return;
        this.socket = null; this.ready = false; this.connecting = false; this.buttons();
        if (!failed) this.status('SSH-сеанс закрыт.');
      };
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.socket = null; this.ready = false; this.connecting = false; this.buttons();
      this.status('Подключение не выполнено: ' + error.message);
    }
  }
  disconnect(message) {
    this.epoch++; this.ready = false; this.connecting = false;
    const socket = this.socket; this.socket = null;
    if (socket) {socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close(1000, 'client_disconnect');}
    this.buttons(); if (message) this.status(message);
  }
  close() {
    this.disconnect(); this.canConnect = false; this.nodeId = ''; this.buttons();
    this.observer?.disconnect(); this.observer = null;
    this.terminal?.dispose(); this.terminal = null;
    this.elements.sshTerminal.replaceChildren();
  }
}
window.CitadelSshTerminal = CitadelSshTerminal;
