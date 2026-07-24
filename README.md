# Receipt Management System — Server Edition

A shared, multi-user receipt system. It runs as a small web server: everyone on the
network opens it in a browser, **all data is stored centrally on the server**, and
**logins and access rights are enforced on the server** (not in the browser).

- Real shared data — a receipt one person creates is instantly visible to everyone.
- Real logins — accounts and rights (View / Edit / Export / Admin) live on the server.
- No external dependencies — pure Node.js. Nothing to `npm install`.
- Data is stored in a single `data.json` file next to the server.

---

## What's in this folder

```
receipt-server.js     the server (run this)
public/index.html     the app the browser loads
package.json          lets you run "npm start"
data.json             created automatically on first run (your live data)
```

---

## 1. Install Node.js (one time, on the server machine)

Download the LTS version from https://nodejs.org and install it.
Check it works — open a terminal / Command Prompt and run:

```
node --version
```

Any version 16 or newer is fine.

---

## 2. Run the server

Open a terminal in this folder and run **either**:

```
node receipt-server.js
```

or

```
npm start
```

You'll see:

```
 Receipt Management System is running.
 On this machine:      http://localhost:3000
 From other computers: http://<this-machine-ip>:3000
```

The first run also prints the default admin login:
**username `admin`, password `admin`** — sign in, then change it immediately in the
**Users** tab.

---

## 3. Open it

- On the server machine: browse to **http://localhost:3000**
- From other computers on the same network: **http://SERVER-IP:3000**
  (find the server's IP with `ipconfig` on Windows or `ip a` / `ifconfig` on Mac/Linux —
  e.g. `http://192.168.1.50:3000`)

Everyone who opens that address gets the login screen. Give each colleague their own
username and set their rights in the Users tab.

If other computers can't reach it, allow **port 3000** through the server's firewall
(Windows Defender Firewall → Inbound rule for port 3000).

---

## 4. Keep it running

While you're testing, the terminal window must stay open. For always-on use:

**Windows** — easiest is to install [PM2](https://pm2.keymetrics.io):
```
npm install -g pm2
pm2 start receipt-server.js --name receipts
pm2 save
```
PM2 keeps it running and restarts it after reboots (see `pm2 startup`).

**Linux (systemd)** — create `/etc/systemd/system/receipts.service`:
```
[Unit]
Description=Receipt Management System
After=network.target
[Service]
WorkingDirectory=/path/to/this/folder
ExecStart=/usr/bin/node receipt-server.js
Restart=always
[Install]
WantedBy=multi-user.target
```
Then: `sudo systemctl enable --now receipts`

---

## 5. Deploying to a cloud server (accessible from anywhere)

Put this folder on any small cloud VM (Azure, AWS Lightsail, DigitalOcean, etc.):

1. Create a Linux VM and install Node.js.
2. Copy this folder to the VM (e.g. with `scp` or Git).
3. Run it with PM2 or systemd (above).
4. Open the VM's firewall / security group for your chosen port.
5. **Strongly recommended:** put it behind HTTPS. Run a reverse proxy (Nginx or Caddy)
   in front of it so traffic is encrypted. Caddy example (`Caddyfile`):
   ```
   receipts.yourdomain.com {
       reverse_proxy localhost:3000
   }
   ```
   Caddy fetches a free TLS certificate automatically. Without HTTPS, passwords travel
   in plain text — only skip it on a trusted internal network.

To change the port: set an environment variable, e.g. `PORT=8080 node receipt-server.js`.

---

## 6. Backups

Your entire system is the single file **`data.json`**. To back up, just copy it somewhere
safe on a schedule (a nightly copy to another drive or cloud folder is plenty for a small
team). To restore, stop the server, replace `data.json`, start it again. You can also use
the in-app Excel exports for human-readable copies.

---

## 7. Security notes (please read)

- Passwords are hashed (scrypt) on the server — they are never stored in plain text.
- Rights are enforced server-side, so a view-only user genuinely cannot change data even
  if they tamper with the page.
- **Use HTTPS** for anything beyond a trusted internal LAN (see step 5).
- Sessions last 12 hours and reset if the server restarts (users simply log in again).
- Keep the server machine patched and limit who can reach the port.

---

## 8. Everyday use

- **Users tab (Admin only):** create accounts, set View / Edit / Export / Admin.
- **Settings:** your organization details + home state (drives CGST+SGST vs IGST) and the
  receipt-number prefix. Receipt numbers are assigned by the server so they never clash.
- **New Receipt:** pick a partner (GST type auto-selected), add students, add service
  lines, choose payment method (non-cash requires Ref No. + Bank), set Paid/Prepaid-by/Note,
  then Save or Save & Print (browser → Save as PDF).
- **Transactions:** shared ledger for everyone, searchable, with totals and balance due.
- **Partners / Services:** shared master lists with Excel import/export.

Enjoy — and if you later want features like editable "record a payment against a balance",
audit logs of who changed what, or emailing receipts, those are natural next steps.
