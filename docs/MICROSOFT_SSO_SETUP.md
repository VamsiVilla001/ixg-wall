# Microsoft 365 sign-in for IXG Wall

IXG Wall signs people in with their organisation's Microsoft 365 account through Microsoft Entra ID. This guide is for the person who sets that up: an Entra administrator (or someone with the Application Administrator role) and the wall's first admin.

Microsoft sign-in only decides who someone is. Whether they get in, and as what, is decided by IXG Wall's own allow-list or by app roles you assign in Entra. Nobody gets in just because their email belongs to the organisation.

It does not replace the YouTube channel sign-in, the YouTube API key, or the Slack, Google Drive and OneDrive connections. Those keep their own credentials, set in the Admin center, and the background work (polling, PCV tracking, screenshots, uploads) runs on them without anyone being signed in.

## How it works

| Part | What IXG Wall does |
|---|---|
| Flow | OAuth 2.0 authorization code flow with PKCE (S256), a `state` per sign-in (single use, 10 minutes) and an OpenID Connect `nonce` |
| Client type | Confidential: the wall's server exchanges the code with the client secret. The secret never reaches a browser |
| Authority | `https://login.microsoftonline.com/<tenant ID>` when the tenant ID is set (recommended); otherwise `/organizations`, which never admits personal accounts |
| Identity | The ID token, checked on the server: RS256 signature against Microsoft's published keys, issuer, audience (the client ID), expiry, not-before, nonce, tenant. Personal-account tokens and other tenants are refused |
| Who it is | The Entra Object ID (`oid`) in the tenant. An account added by email is bound to its Object ID on its first sign-in, so a change of email or name keeps its access and nobody else can take the old address over |
| Session | An HttpOnly, SameSite=Lax cookie signed by the server (Secure on https), naming the role and the account. It lasts 8 hours. The wall renews it quietly in a hidden frame 15 minutes before it ends (`prompt=none`), so Conditional Access and MFA still apply. If Microsoft wants the person back, a notice asks them to sign in while the wall keeps running |
| Access checks | On every request. Removing an account, changing its role, or narrowing its sessions takes effect on its next request and closes its live connections |
| Tokens kept | None. The ID token is checked and dropped. No Microsoft access or refresh token is stored for sign-in |
| Sign-out | Ends the wall session, then sends the browser to Microsoft's sign-out for this app, which returns to the sign-in page |
| Audit | Every sign-in, refusal, renewal, sign-out and change to who may sign in, with the address, in `auth-audit.log` in the data folder. Admins see the latest under Admin center → Access. Nothing secret is written |

## Roles

| IXG Wall role | Entra app role value | What it may do |
|---|---|---|
| Admin | `IXG.Admin` | Everything: the Admin center (Access, links, YouTube key and channel sign-in, Slack, Drive, OneDrive, folders), every session |
| Operator | `IXG.Operator` | Runs the wall: adds feeds, starts and archives sessions, screenshot settings and manual captures. No Admin center, no integrations, not the poll interval or memory settings |
| User | `IXG.User` (or `IXG.Viewer`) | Watches and arranges the wall: order, rename, layout, playback. Adds no feeds, runs no sessions |

Projects are sessions in IXG Wall. Any account in the Access list can be limited to one session or to several. A project manager is an operator limited to their own sessions: they see only those, cannot open another session's address or data, and cannot start new sessions.

The server enforces every one of these. Hidden buttons are only tidiness.

## 1. Register the app

In the [Microsoft Entra admin center](https://entra.microsoft.com), go to **Identity → Applications → App registrations → New registration**.

1. **Name:** `IXG Wall`.
2. **Supported account types:** *Accounts in this organizational directory only (single tenant)*.
3. **Redirect URI:** platform **Web**, value `https://wall.yourcompany.com/api/auth/microsoft/callback` (your wall's address).
4. Register. On the **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.

The same app serves the OneDrive screenshot archive. If you use OneDrive too, add its redirect URI as well (step 2).

## 2. Redirect URIs and sign-out

**Authentication → Web → Redirect URIs.** Add every address the wall is opened at:

| Where | Redirect URIs |
|---|---|
| Production | `https://wall.yourcompany.com/api/auth/microsoft/callback`<br>`https://wall.yourcompany.com/api/onedrive/callback` |
| A laptop wall | `http://localhost:8080/api/auth/microsoft/callback`<br>`http://localhost:8080/api/onedrive/callback` |
| A local test of the website | `http://localhost:8090/api/auth/microsoft/callback` |

Microsoft accepts `http://` only for `localhost`.

**Front-channel logout URL:** `https://wall.yourcompany.com/login`.

Leave **Implicit grant and hybrid flows** unticked: ID tokens and access tokens both come from the code exchange.

## 3. Client secret

**Certificates & secrets → Client secrets → New client secret.** Pick an expiry your policy allows, and copy the **Value** at once: it is shown only once.

Put a reminder in the calendar before it expires. An expired secret stops Microsoft sign-in and OneDrive uploads; the wall says so on the sign-in page and in the Admin center. The wall password still works as the fallback unless an admin switched it off.

## 4. API permissions

**API permissions → Add a permission → Microsoft Graph → Delegated permissions.**

| Permission | Needed for |
|---|---|
| `openid`, `profile`, `email` | Sign-in |
| `User.Read`, `Files.ReadWrite`, `offline_access` | Only for the OneDrive archive |

Then **Grant admin consent for <your organisation>** so nobody is asked to consent on their first sign-in.

IXG Wall has no separate API of its own to register: its browser pages and its server are one site, and the server checks the signed session cookie on every request. No "Expose an API" scope is needed.

## 5. App roles and assignment (recommended)

Two ways to say who gets in, which work together:

- **App roles in Entra.** Under **App roles → Create app role**, make three roles for *Users/Groups* with the values `IXG.Admin`, `IXG.Operator` and `IXG.User`. Then in **Enterprise applications → IXG Wall → Users and groups**, assign people or groups to them. A role assigned in Entra wins over the wall's own list for that account, and the Access list shows it as "app role from Microsoft Entra".
- **The wall's own list.** Admin center → Access: add an email, choose a role and, if wanted, a session.

To make sure nobody outside the assignments can even reach the consent step, in **Enterprise applications → IXG Wall → Properties** set **Assignment required?** to **Yes**. Then only assigned users and groups can sign in at Microsoft at all; the wall's own list still decides the rest.

## 6. Give the wall its settings

On the server, in `/etc/ixg-wall/ixg-wall.env` (or `.env` for a local test, see `.env.example`):

```env
MS_TENANT_ID=<Directory (tenant) ID>
MS_CLIENT_ID=<Application (client) ID>
MS_CLIENT_SECRET=<client secret Value>
IXG_ADMINS=you@yourcompany.com
```

Then restart the wall:

```sh
sudo systemctl restart ixg-wall
```

Instead of the environment, an admin signed in with the wall password can paste the client ID, secret and tenant ID under **Admin center → Where screenshots go → OneDrive**. The wall checks them with Microsoft before saving and keeps the secret in `secrets.json`, which is never sent to a page.

**The first admin.** `IXG_ADMINS` lists the accounts (emails, or Entra Object IDs) that are admins from the start. It is the only way an admin comes into being without another admin, or an Entra `IXG.Admin` assignment, granting it. Nobody becomes an admin by being first to sign in.

## 7. First sign-in and switching the password off

1. Open the wall. The sign-in page leads with **Sign in with Microsoft**.
2. Sign in with the account in `IXG_ADMINS`. You land in the wall as an admin; the Admin center's Access list shows your account bound to its Object ID.
3. Add the people who need access, or assign the Entra app roles.
4. Under **Admin center → Access**, switch off **The wall password also signs admins in**. From then on only Microsoft accounts get in. The switch can go off only while an admin account is listed, and the password comes back by itself if the Microsoft app is ever removed.

User links keep working beside Microsoft sign-in for people outside the organisation, such as a client reviewing one session. Revoke them in Admin center → User links.

## Troubleshooting

The sign-in page shows Microsoft's refusal in words. The full reason is in the server's log and in `auth-audit.log`.

| What the page says | Why, and what to do |
|---|---|
| "… isn't allowed in" | The account is not in Admin center → Access and has no Entra app role. Add it, or assign a role |
| "This account belongs to another organisation" | Its tenant isn't the wall's. Check `MS_TENANT_ID`, or that the account is a member, not a guest from elsewhere |
| "Personal Microsoft accounts can't sign in" | An outlook.com or live.com account was used. Use the work account |
| "Sign-in was cancelled" | The person closed or declined the Microsoft page. Start again |
| "Microsoft refused the sign-in: AADSTS50011 …" | The redirect URI isn't registered: add the exact address from step 2 |
| "… AADSTS7000215 …" or "… AADSTS7000222 …" | The client secret is wrong or expired. Make a new one (step 3) |
| "… AADSTS700016 …" | The client ID is wrong, or the app was deleted |
| "… AADSTS50105 …" | Assignment is required and the person has no assignment. Assign them in Enterprise applications |
| "… AADSTS65001 …" | Consent is missing. Grant admin consent (step 4) |
| "The sign-in took too long and its token expired" | The server's clock is off, or the sign-in sat for a long time. Check the clock (`timedatectl`) |
| "Couldn't fetch Microsoft's signing keys" | The server can't reach login.microsoftonline.com. Check its outbound HTTPS |
| A notice on the wall: "couldn't be renewed quietly" | Microsoft wants the person (MFA due, a Conditional Access change, or they signed out of Microsoft). Click **Sign in again**. The wall keeps running until the session ends |
| "Your sign-in ended, or your access changed" | The session reached its end, or an admin removed the account or changed its role or sessions. Sign in again |
| "Too many refused sign-ins from this address" | Ten refusals within 15 minutes lock the address for the rest of that window |
