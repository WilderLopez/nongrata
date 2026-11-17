# Setting up the NonGrata Dashboard from scratch

*Español: [CONFIGURAR-DASHBOARD.md](es/CONFIGURAR-DASHBOARD.md)*

From nothing to the [NonGrata Dashboard](https://github.com/WilderLopez/nongrata-dashboard) app
(iPhone, iPad or Mac) administering your own Worker. Three steps: a Worker, the app, and pairing
the two.

This is the how-to. The protocol behind step 3 (what is signed, the roles, the threat model) is
in [Admin devices](DEVICE-PAIRING.md).

## What you need

| | |
|---|---|
| A Cloudflare account | Workers and D1; the free plan is enough to start |
| On your computer | Node 22.18 or later, pnpm, and a checkout of this repo |
| For the app | Xcode 16 or later; an iPhone or iPad on iOS 17, or a Mac on macOS 14 with Apple silicon or a T2 chip |

A DeviceCheck key from Apple is **not** needed to pair the Dashboard. Without it the Worker
decides with its own list alone; add it when you integrate the SDK into your app
([Integrating into an iOS app](INTEGRATION-IOS.md)).

## 1. Deploy the Worker

Already have a NonGrata Worker? Go to [1.4](#14-a-worker-deployed-before-pairing-existed).

### 1.1 Create the deployment

```sh
git clone https://github.com/WilderLopez/nongrata.git && cd nongrata
make install
cp -r deployments/example deployments/<your-app>    # git ignores this folder
cd worker
pnpm exec wrangler login                             # once per computer
pnpm exec wrangler d1 create nongrata-<your-app>     # prints the database_id
```

### 1.2 Fill in `deployments/<your-app>/wrangler.jsonc`

| Field | Value |
|---|---|
| `name`, `database_name` | `nongrata-<your-app>` |
| `database_id` | The one `d1 create` printed |
| `namespace_id` | A whole number that no other rate limiter in your Cloudflare account uses, for example `1001` |
| `HASH_PREFIX_MYAPP` | Rename the variable to your app (`HASH_PREFIX_<APP>`, uppercase, `-` as `_`) and give it a value such as `<your-app>-ban-v1`. Never change it afterwards: every hash depends on it |
| `ENFORCE_MYAPP` | Rename it the same way and leave it `"false"` (observation mode) |
| `APPLE_TEAM_ID_MYAPP`, `APPLE_KEY_ID_MYAPP` | Rename and fill them if you have the DeviceCheck key; delete both lines if not |

### 1.3 Secrets, database and deploy

`ADMIN_TOKEN` is a password you make up; it is the master credential of the Worker. Generate a
good one and keep it in a password manager: step 3 needs it.

```sh
openssl rand -base64 32      # copy the output: this is your ADMIN_TOKEN
```

From `worker/`:

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config ../deployments/<your-app>/wrangler.jsonc
pnpm exec wrangler secret put ADMIN_TOKEN --config ../deployments/<your-app>/wrangler.jsonc   # paste it when asked
pnpm exec wrangler deploy --config ../deployments/<your-app>/wrangler.jsonc
```

`deploy` prints the Worker's address, `https://nongrata-<your-app>.<your-subdomain>.workers.dev`.
Keep it too.

With a DeviceCheck key, also:

```sh
pnpm exec wrangler secret put APPLE_DC_KEY_P8_<APP> --config ../deployments/<your-app>/wrangler.jsonc < AuthKey_<KEY_ID>.p8
```

### 1.4 A Worker deployed before pairing existed

Pairing needs migration `0003` and the current code. From an up-to-date checkout, in `worker/`,
apply the migrations **first** and deploy after (the new code writes columns the old database
does not have):

```sh
pnpm exec wrangler d1 migrations apply DB --remote --config ../deployments/<your-app>/wrangler.jsonc
pnpm exec wrangler deploy --config ../deployments/<your-app>/wrangler.jsonc
```

## 2. Get the app

Build it from its repo, [NonGrata Dashboard](https://github.com/WilderLopez/nongrata-dashboard):
its README has the steps (XcodeGen, your Team ID in a local config file, run from Xcode). It
needs a signed build on a real device or a Mac: the key of step 3 lives in the Secure Enclave.

Without a Worker, the app can still be explored with its sample data.

## 3. Pair the app with the Worker

On your computer, from the root of this repo, with the address and the token of step 1:

```sh
export NONGRATA_URL=https://nongrata-<your-app>.<your-subdomain>.workers.dev
export NONGRATA_ADMIN_TOKEN=<your ADMIN_TOKEN>
pnpm ng pair app=<your-app> role=admin label="My Mac"
```

The terminal draws a QR code, prints the same thing as a link (`nongrata://pair?…`) and waits:

```text
Scan with NonGrata Dashboard (expires in 10 min):
  ▄▄▄▄▄▄▄ ▄ ▄▄ ▄▄▄▄▄▄▄
  …
Or open: nongrata://pair?v=1&url=…
Waiting for the device…
```

In the app, choose **Connect Your Worker**:

- **iPhone or iPad:** scan the QR code.
- **Mac:** copy the link from the terminal and paste it in the app. Opening the link
  (`open "nongrata://pair?…"`) does the same.

Then:

1. The app shows the Worker's address. Check that it is yours and confirm.
2. The app and the terminal show a **6-digit code**. Compare them.
3. If they are the same, answer `y` in the terminal. Any other answer cancels the pairing and
   removes that device.

```text
Claimed by "MacBook Pro" (macos).
Verification code: 123 456. Does the device show the same code? [y/N] y
Paired: device 7sK… with role admin.
```

The app opens on your Worker. From here on it never uses the token: it signs every request with
a key that does not leave the device.

## 4. Check it

```sh
pnpm ng devices app=<your-app>     # your device, with "status": "active"
```

In the app, Settings shows the Worker, its apps and this device's role.

## More devices, roles and removing one

- **One pairing per device.** The link works once, for 10 minutes. Run `pnpm ng pair` again for
  each iPhone, iPad or Mac.
- **Roles.** `role=read` can look at everything and change nothing. `role=admin` can also ban,
  unban and revoke devices. No device can pair another one: that always takes the token.
- **Remove a device.** `pnpm ng devices revoke app=<your-app> id=<device_id>`, or from another
  admin device in the app. It is permanent; to use that device again, pair it again.
- **Several Workers.** Pair the app once with each; it keeps one key per Worker.

## If something goes wrong

| What you see | Why, and what to do |
|---|---|
| `missing NONGRATA_URL…` or `missing NONGRATA_ADMIN_TOKEN…` | The two `export` lines of step 3 are not set in this terminal |
| `HTTP 401` with `unauthorized` in the terminal | The token is not that Worker's `ADMIN_TOKEN`. Set it again with `wrangler secret put ADMIN_TOKEN` if you lost it; the paired devices keep working |
| `HTTP 404` with `not_found` when pairing | The Worker is older than pairing: do [1.4](#14-a-worker-deployed-before-pairing-existed) |
| `the pairing is expired` or `no device claimed the pairing in time` | The 10 minutes ran out. Run `pnpm ng pair` again |
| The QR code does not scan | Make the terminal window bigger or the font smaller, or use the link |
| The codes are different | Answer `N`. Someone else claimed that pairing; run the command again and do not share the link |
| The app says the clock is wrong | Signed requests allow 5 minutes of difference with the Worker. Set the device's date and time to automatic |
| The app asks to pair again | Face ID or Touch ID was re-enrolled, which invalidates the key. Pair again and revoke the old entry |

## See also

- [Admin devices](DEVICE-PAIRING.md): the pairing protocol, signed requests, roles and threats.
- [Admin API](ADMIN-API.md): everything the app and the CLI can ask the Worker.
- [Cloudflare Worker and D1](concepts/cloudflare-worker-and-d1.md): what each piece of the
  deployment is.
