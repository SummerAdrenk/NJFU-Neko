// 模拟 Fabric 客户端在“配置阶段”的最小握手。
//
// 装了 Fabric API 的服务器（包括开了局域网的 Fabric 单机世界）会做注册表同步：
// 如果客户端没有声明自己能接收 fabric:registry/sync，而服务器上又有模组注册的内容，
// 就会以“This server requires Fabric API installed on your client!”把客户端踢出。
//
// 握手流程（全部发生在配置阶段）：
//   1. 一进入配置阶段就发 minecraft:register，声明我们能接收的频道。
//      必须赶在回复服务器的 ping 之前发出，否则服务器会认为客户端没有任何频道。
//   2. 服务器发 c:version → 回复我们支持的版本 [1]。
//   3. 服务器发 c:register → 回复配置阶段我们能接收的频道。
//   4. 服务器发 fabric:registry/sync（注册表数据）→ 回复 fabric:registry/sync/complete。
// 对普通（非 Fabric）服务器，这些自定义数据包会被直接忽略，没有副作用。

const CHANNELS = ['c:version', 'c:register', 'fabric:registry/sync'];

function varInt(value) {
  const bytes = [];
  let n = value >>> 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    bytes.push(b);
  } while (n);
  return Buffer.from(bytes);
}

function mcString(text) {
  const data = Buffer.from(text, 'utf8');
  return Buffer.concat([varInt(data.length), data]);
}

export const payloads = {
  register: () => Buffer.from(CHANNELS.join('\0'), 'utf8'),
  version: () => Buffer.concat([varInt(1), varInt(1)]),
  commonRegister: () => Buffer.concat([varInt(1), mcString('configuration'), varInt(CHANNELS.length), ...CHANNELS.map(mcString)]),
};

export function installFabricHandshake(client, report = () => {}) {
  const send = (channel, data) => client.write('custom_payload', { channel, data });

  // minecraft-protocol 在切换到新状态的序列化器之后才触发 'state'，此时写出的已是配置阶段的数据包。
  client.on('state', (state) => {
    if (state === 'configuration') send('minecraft:register', payloads.register());
  });

  client.on('custom_payload', (packet) => {
    if (client.state !== 'configuration') return;
    switch (packet.channel) {
      case 'c:version':
        send('c:version', payloads.version());
        break;
      case 'c:register':
        send('c:register', payloads.commonRegister());
        break;
      case 'fabric:registry/sync':
        send('fabric:registry/sync/complete', Buffer.alloc(0));
        report('已完成 Fabric 注册表同步');
        break;
      default:
        break;
    }
  });
}
