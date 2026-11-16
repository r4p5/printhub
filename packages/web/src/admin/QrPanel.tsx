import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { Overview } from './types';

export function QrPanel({ overview, shopName }: { overview: Overview; shopName: string }) {
  const online = overview.online.enabled;
  const [svg, setSvg] = useState('');
  const url = overview.customerUrl;

  useEffect(() => {
    if (url) QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg);
  }, [url]);

  if (!url) {
    return <p className="text-sm text-amber-700">Save the shop details (and connect this computer to the shop Wi-Fi, or turn on online orders) to get a QR code.</p>;
  }

  const download = async () => {
    const png = await QRCode.toDataURL(url, { width: 1024, margin: 2, errorCorrectionLevel: 'M' });
    const a = document.createElement('a');
    a.href = png;
    a.download = `printhub-qr-${shopName.replace(/\W+/g, '-').toLowerCase()}.png`;
    a.click();
  };

  return (
    <div className="space-y-3">
      <div id="qr-poster" className="mx-auto max-w-xs rounded-xl border border-slate-200 bg-white p-6 text-center">
        <p className="text-lg font-bold">{shopName}</p>
        <p className="text-sm text-slate-600">Scan to print from your phone</p>
        <div className="mx-auto my-3 w-56" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="text-xs text-slate-500">{online ? 'Works on mobile data or any Wi-Fi' : 'Connect to the shop Wi-Fi first'}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <button className="btn-primary" onClick={() => window.print()}>Print poster</button>
        <button className="btn-secondary" onClick={download}>Download QR image</button>
      </div>
      <dl className="space-y-1 text-xs text-slate-600">
        <div><dt className="inline font-medium">Customer link: </dt><dd className="inline break-all font-mono">{url}</dd></div>
        <div><dt className="inline font-medium">Direct link (same Wi-Fi): </dt><dd className="inline break-all font-mono">{overview.directUrl}</dd></div>
      </dl>
      {online ? (
        <p className="text-xs text-slate-500">This QR never changes, even if the computer's network address changes. Customers on the shop Wi-Fi can also use the direct link.</p>
      ) : (
        <p className="text-xs text-slate-500">
          The QR includes this computer's network address ({overview.server.addresses[0]?.address}). If your router gives the computer a different address, reprint the QR,
          or reserve the address in the router settings (DHCP reservation) so it never changes. Turning on online orders avoids this.
        </p>
      )}
    </div>
  );
}
