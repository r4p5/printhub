import { networkInterfaces } from 'node:os';
import { isPrivateIp } from './http.ts';

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|hamachi|vpn|tap|tun/i;

/** LAN IPv4 addresses customers could reach, real Wi-Fi/Ethernet adapters first. */
export function lanAddresses(): { address: string; iface: string }[] {
  const out: { address: string; iface: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateIp(a.address) || a.address.startsWith('169.254.')) continue;
      const score = VIRTUAL_ADAPTER.test(name) ? 2 : /wi-?fi|wlan|wireless/i.test(name) ? 0 : 1;
      out.push({ address: a.address, iface: name, score });
    }
  }
  return out.sort((a, b) => a.score - b.score).map(({ address, iface }) => ({ address, iface }));
}
