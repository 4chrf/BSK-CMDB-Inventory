# BSK CMDB — on-premise deployment guide

This repository now includes a standalone Node.js backend with MariaDB, local accounts, and HTTPS through Nginx. It does not require ChatGPT, OpenAI Sites, Cloudflare D1, or internet access at runtime. Downloading packages/images initially requires internet access or approved internal mirrors.

The private hosted Site remains separate. Deploying this repository does not synchronize or change its database. The public repository contains only fictional samples; production inventory must be transferred privately using an inventory backup.

## 1. Architecture and prerequisites

| Component | Single-server deployment | Separate-database deployment |
| --- | --- | --- |
| Web entry point | Nginx on the Linux host, TCP 443 | Nginx on application VM, TCP 443 |
| Application | Node.js container, localhost TCP 3000 | Node.js container, localhost TCP 3000 |
| Database | Separate MariaDB 11.4 container and persistent volume; no published DB port | MariaDB 11.4 on database VM, TCP 3306 restricted to application VM; TLS required |
| Identity | Explicitly provisioned local accounts | Same |
| Inventory data | MariaDB, retained across container replacements | MariaDB on database VM |

Suggested starting size, not a benchmark: 2 vCPU, 4 GB RAM, and 30 GB disk for a small internal deployment; allocate backup space separately. For two VMs, start with 2 vCPU/2 GB RAM for the app and 2 vCPU/4 GB RAM for the database, then measure usage. Use an internal DNS name such as `cmdb.example.internal`, a company-CA TLS certificate, time synchronization, and a supported Linux release. Examples below target a dedicated RHEL 9 host. These are placeholders; substitute your actual DNS names and IP addresses.

Use your organization's supported Docker/Compose distribution. Do not remove Podman or container packages from an existing shared server without checking other workloads. On a clean RHEL host approved for Docker CE, the official installation path is:

```bash
sudo dnf install -y dnf-plugins-core git nginx openssl
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
docker compose version
```

Run subsequent Docker commands with an authorized account (`sudo` if needed). Membership in the Docker group grants host-level administrative power. Consult [Docker's RHEL instructions](https://docs.docker.com/engine/install/rhel/) for current prerequisites and package conflicts.

## 2. Download the code and set your address

```bash
sudo mkdir -p /opt/bsk-cmdb
sudo chown "$(id -un):$(id -gn)" /opt/bsk-cmdb
git clone https://github.com/4chrf/BSK-CMDB-Inventory.git /opt/bsk-cmdb
cd /opt/bsk-cmdb
cp .env.example .env
```

Edit `.env` and set the exact browser origin, without a trailing slash:

```dotenv
APP_ORIGIN=https://cmdb.example.internal
```

Do not use a different hostname/IP in the browser: write requests must match this origin. DNS must resolve to the application VM. Passwords are held in excluded files, not in the repository.

## 3. Create the database passwords

```bash
cd /opt/bsk-cmdb
umask 077
mkdir -p secrets certs
chmod 700 secrets certs
openssl rand -hex 32 > secrets/db_password.txt
openssl rand -hex 32 > secrets/db_root_password.txt
chmod 444 secrets/db_password.txt
chmod 400 secrets/db_root_password.txt
```

The application password file is readable inside the non-root app container. Its parent directory remains accessible only to the operator on the host. Compose mounts it at `/run/secrets/db_password`; no password is included in the image. Keep an encrypted, access-controlled copy of these files. Changing the file does not rotate a password in an existing database: coordinate a database user password change and restart the application when rotating credentials.

For the single-server setup continue with section 4. For a database on another VM, use section 10 instead of starting the bundled database.

## 4. Start the application and database

```bash
cd /opt/bsk-cmdb
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
curl --fail http://127.0.0.1:3000/healthz
```

The health check should return `{"ok":true}`. The database schema is created automatically inside `cmdb`. Startup never replaces existing inventory. The default on-premise database is empty; samples are optional via `SEED_SAMPLE_DATA=true` **only before the first startup of a new database**. All included samples are fictional and labelled.

Application data lives in the `bsk-cmdb_db_data` Docker volume. `docker compose down` retains it. **Do not run `docker compose down -v` or delete the volume** unless you intentionally want to delete the database and have a verified backup.

## 5. Configure HTTPS

Obtain a certificate and private key from your company CA covering the CMDB DNS name. Install them at the paths referenced by `deploy/nginx.conf`, or edit those paths:

```text
/etc/pki/tls/certs/cmdb-fullchain.pem
/etc/pki/tls/private/cmdb.key
```

Restrict the private key to root. Then:

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/cmdb.conf
sudo vi /etc/nginx/conf.d/cmdb.conf
sudo nginx -t
sudo setsebool -P httpd_can_network_connect 1
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

The `setsebool` command applies when SELinux is enabled on RHEL; keep SELinux enforcing. If firewalld is active, allow HTTPS and optional HTTP redirect from your approved internal subnets using your site's firewall policy. Do not expose TCP 3000 or 3306 to end users. The bundled database has no host port mapping.

Open `https://cmdb.example.internal`. The application uses Secure, HttpOnly, SameSite cookies. HTTP is rejected by default; `ALLOW_HTTP=true` exists only for isolated development/testing, not production.

## 6. Create your administrator and end-user accounts

There is no default password and no first-visitor registration. Provision the first administrator explicitly from the server console:

```bash
cd /opt/bsk-cmdb
docker compose exec app node onprem/cli.mjs create-user achraf@example.internal admin
```

Enter a password of 14–256 characters when prompted. Input is not echoed. Replace the example address with your real login email. Create read-only users the same way:

```bash
docker compose exec app node onprem/cli.mjs create-user user@example.internal reader
```

Use these addresses and passwords at the sign-in page. `/` is always the read-only inventory interface, including for administrators. `/admin` opens the administration workspace for an authenticated administrator. No administration link is shown on the end-user page.

On Administration, change roles and enable/disable access. Changes are enforced in the backend and revoke the affected user's sessions. A transactional lock prevents disabling or demoting the last enabled administrator, including concurrent updates. There is no public signup, default admin, email-only authorization, or trust in caller-supplied identity headers.

To reset a forgotten password from the authorized server console:

```bash
docker compose exec app node onprem/cli.mjs reset-password achraf@example.internal
```

This revokes existing sessions, clears login throttling for that account, and retains inventory, roles, and history. Console actions are attributed to `local-console`; browser changes use the actual signed-in account. Console access must therefore be limited and independently audited by your server administration controls.

Sessions expire after 30 minutes. Login is limited to five attempts per account per 15 minutes. Passwords are stored as salted scrypt hashes. This implementation provides local authentication; AD/LDAP, SAML/OIDC and MFA are not implemented.

## 7. Transfer inventory from the private Site

1. Sign in as administrator on the existing private Site and choose **Back up inventory**.
2. Transfer that JSON backup securely to the workstation used for on-premise administration. Do not upload it to this public GitHub repository.
3. Open the on-premise `/admin` page and choose **Restore inventory**.
4. Select the backup, review the confirmation, then restore.
5. Compare host, application and rack counts; check several physical and virtual hosts and their complete fields.

This retains CMDB fields, application catalog, room/rack placements, multi-unit hosts, VMware fields, source metadata and sample labels. Inventory restore replaces the target inventory and retains its local account credentials and dedicated audit history. Legacy inventory audit records from the imported file are not imported as trusted server-attributed history; retain the original backup separately for historical evidence. The hosted Site's separate access/history database is not included in an inventory JSON backup. CSV import is also available, but JSON backup/restore is the route for preserving the complete inventory model.

If the private Site still cannot authenticate, resolve that access problem before exporting. This repository does not contain your production data, and no live data migration has been performed for you.

## 8. Backups and disaster recovery

Two backup levels serve different purposes:

| Backup | Includes | Restore path |
| --- | --- | --- |
| Administration JSON | Inventory and source metadata | Application **Restore inventory**; does not restore local accounts |
| MariaDB dump | Inventory, users, password hashes, audit history and schema | Database restore script; replaces database state |

For the bundled database:

```bash
cd /opt/bsk-cmdb
bash deploy/backup.sh
```

It creates a compressed, permission-restricted backup under `backups/`. Copy it off the server to your approved encrypted backup system. Back up `.env`, secrets, and TLS configuration separately. Avoid schema deployments while the dump is running. Establish retention and recovery objectives with the infrastructure team and test restores on an isolated VM.

To restore a chosen database backup, **take a fresh backup first**, schedule downtime, and run:

```bash
bash deploy/restore.sh backups/cmdb-YYYYMMDDTHHMMSSZ.sql.gz --replace
```

The script stops the application, replaces database tables using the dump, clears saved sessions, and restarts the app. On import failure it leaves the app stopped for investigation. This restores accounts and their passwords to the backup point. Operators must verify the recovered data before reopening service.

The scripts target the bundled `compose.yaml` database only. For a separate database server use the DBA team's MariaDB backup/restore service. A typical logical backup is `mariadb-dump --single-transaction --quick --routines --events --triggers --databases cmdb`, using a protected client configuration and appropriate backup permissions. Do not put passwords in command arguments or commit dumps. See [MariaDB backup guidance](https://github.com/mariadb-corporation/mariadb-docs/blob/main/server/mariadb-quickstart-guides/mariadb-backup-guide.md).

## 9. Updates, rollback and operations

```bash
cd /opt/bsk-cmdb
bash deploy/backup.sh
git rev-parse HEAD       # retain this revision for rollback
git pull --ff-only
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
```

Test releases on a QA instance before production. Pin approved Git commits and container image digests for controlled deployments; the supplied tags are convenient starting points, not immutable release pins. If only application code changed, check out the approved previous commit and rebuild. If a future version changes the schema, follow its migration/rollback notes and restore the matching database backup if needed. Do not blindly downgrade MariaDB data files across major versions.

Monitor container health/restarts, HTTP errors, database connectivity, disk capacity, backup success and certificate expiry. Nginx logs are in `/var/log/nginx`; application logs are available through `docker compose logs app`. Never log password request bodies. Set Docker log rotation through your host's standard daemon configuration. Restrict access to the CMDB network and backup location.

## 10. MariaDB on a separate server

Use this option when you want the application and database on different VMs. Install a supported MariaDB 11.4 release using your organization's approved repository. Configure an InnoDB database, trusted server certificate/key and CA, the private database interface, and a firewall rule permitting TCP 3306 **only from the app VM**.

As the database administrator, replace `APP_VM_IP` and the password below:

```sql
CREATE DATABASE cmdb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'cmdb'@'APP_VM_IP' IDENTIFIED BY 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, REFERENCES ON cmdb.* TO 'cmdb'@'APP_VM_IP';
```

The password must match `secrets/db_password.txt` on the application VM. Use a trusted console for provisioning and handle SQL client history according to your credential policy. This account is scoped to the CMDB database; never run the application as database root. Startup creates missing tables, so CREATE privileges are needed by this version. Future schema upgrades may require an explicit DBA migration.

Copy the database CA certificate to `certs/db-ca.pem` on the app VM, readable by the app container (mode 444 inside the protected `certs` directory). The certificate must match `DB_HOST`; TLS certificate verification stays enabled. Configure `.env`:

```dotenv
APP_ORIGIN=https://cmdb.example.internal
DB_HOST=db.example.internal
DB_PORT=3306
DB_NAME=cmdb
DB_USER=cmdb
```

Then run this independent Compose definition (not as an override):

```bash
docker compose -f compose.external-db.yaml config --quiet
docker compose -f compose.external-db.yaml up -d --build
docker compose -f compose.external-db.yaml logs --tail=100 app
docker compose -f compose.external-db.yaml exec app node onprem/cli.mjs create-user achraf@example.internal admin
```

Use `-f compose.external-db.yaml` for every subsequent Compose command in this deployment. Keep the Nginx configuration from section 5. Do not start both Compose definitions against the same application port. If migrating from the bundled DB, back it up first, stop the original application, have the DBA restore into the external database, then start the external configuration and validate counts before removing anything.

## 11. Acceptance checks and troubleshooting

Before production handover, verify:

- An anonymous browser must sign in; untrusted identity headers cannot grant access.
- A reader can search inventory, open rooms/racks/hosts and applications, but cannot make API writes.
- An administrator at `/admin` can create/edit/delete a test host, rack and unused application.
- Deleting a rack retains hosts and removes placements; assigned applications cannot be deleted.
- Role changes invalidate affected sessions; the last enabled administrator cannot be disabled/demoted.
- Backup/restore works on a QA copy; restarting containers preserves inventory.
- A narrow/mobile browser can navigate, scroll tables and close host popups.

| Symptom | Check |
| --- | --- |
| Login/write gives 403 | Browser origin must exactly match `APP_ORIGIN`, including HTTPS and port. |
| Cookie/login loop | Use HTTPS; verify proxy and certificate configuration and browser cookie policy. |
| App unhealthy | `docker compose logs app`, DB health, secret-file readability and DB grants. |
| External DB certificate error | CA file, server SAN matching `DB_HOST`, validity dates and DNS. Do not disable verification. |
| Database connection refused | Private IP binding, firewall, DB_HOST and service availability. |
| 429 login response | Wait 15 minutes or use the authorized console password reset for that account. |
| Changes conflict | Reload the latest inventory before saving; optimistic revision checks protect other users. |
| Empty inventory | Import the private JSON backup; production records are intentionally absent from GitHub. |

Local password/security/routing tests are included. The GitHub Actions workflow runs real MariaDB integration tests and a Docker image build. Review its status before deploying. This environment does not include a Docker daemon or MariaDB server, so local execution of the full stack is not claimed.

## Reference documentation

- [MariaDB Node.js connector](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/getting-started-with-the-node-js-connector)
- [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)
- [Docker Engine on RHEL](https://docs.docker.com/engine/install/rhel/)
