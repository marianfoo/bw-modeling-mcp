# BW Modeling MCP — deployment guide

A read-only MCP server that lets an AI assistant explore SAP BW/4HANA modeling
metadata. Runs on SAP BTP Cloud Foundry. Every user reaches BW **as themselves** via
principal propagation, so BW's own authorizations apply per person — no shared
technical user.

**Read-only is structural, not a setting.** The write tools are not in the build; there
is no flag that turns writing back on. This matters because neither `S_ADT_RES` (a URI
allowlist with no activity field) nor the Cloud Connector ACL (path matching, no HTTP
method filter) can tell a read from a write — so the tool surface and the BW role are
the only two real controls.

**Plan for the SAP-side work, not the deployment.** The `cf push` takes minutes. The
Cloud Connector certificates, the ABAP profile parameters and the BW role take days and
usually involve two teams. Start there.

---

## 1. Prerequisites

| | What | Who |
|---|---|---|
| ☐ | BTP subaccount with Cloud Foundry, entitled for **XSUAA**, **Destination**, **Connectivity** | BTP admin |
| ☐ | Cloud Connector connected to the subaccount, reaching the BW system | Basis |
| ☐ | Principal propagation configured end to end (§2) | Basis |
| ☐ | A display-only BW role (§3) | SAP security |
| ☐ | `/sap/bw/modeling` active in **SICF** | Basis |
| ☐ | BW Search activated in **RSOSM** — otherwise search and area browsing return HTTP 500 | Basis |

## 2. Principal propagation

```
MCP client --XSUAA JWT--> this app --X-User-Token--> Destination service
   --SAP-Connectivity-Authentication--> Cloud Connector
   --short-lived X.509 in SSL_CLIENT_CERT--> BW  --CERTRULE--> ABAP user
```

**Cloud Connector**

1. **System certificate** — the CC's own TLS identity. Self-signed ones must have **no**
   Subject Alternative Names.
2. **CA certificate** — signs the short-lived per-user certificates; needs the
   `keyCertSign` key usage. *A separate certificate from the system one — configuring
   only the latter gives `IllegalStateException: No CA certificate available`.*
3. **Principal Propagation** → subject pattern, e.g. `CN=${login_name}`. Set *Certificate
   Validity (min)* low. Click **Generate Sample Certificate** — CERTRULE needs that file.
4. **Backend Trust Store** → add the CA of BW's server certificate.
5. **Cloud to On-Premises → Principal Propagation → Synchronize**, and mark your IdP
   **Trusted**. This list is empty by default.
6. **Access control entry**: Protocol **HTTPS**, *Allow Principal Propagation* ✓,
   Principal Type **X.509 Certificate**, *System Certificate for Logon* **off**.
7. **Expose the resources** — separate from the system mapping, and the most commonly
   missed step. Add each with *Path and all sub-paths*: `/sap/bw/modeling`, `/sap/bw4`,
   `/sap/bc/http/sap/bw4`, `/sap/opu/odata/sap`. A mapping created earlier for ADT
   exposes only `/sap/bc/adt`.

**ABAP**

8. **STRUST** → SSL server Standard → import the **issuer** of the CC system certificate
   → *Add to Certificate List*.
9. `icm/trusted_reverse_proxy_<x> = SUBJECT="<subj>", ISSUER="<iss>"`
   - Uppercase keywords. Below kernel 7.53, put a blank after each comma in the DN even
     though the CC UI shows none.
   - `icm/HTTPS/trust_client_with_issuer` / `..._with_subject` are the kernel ≤ 7.42
     legacy pair. **Setting both variants means both are ignored** (SAP Note 2052899) —
     a silent, total loss of trust, widely misreported as "the new one wins".
10. `icm/HTTPS/verify_client = 1`. The per-port `VCLIENT=` on `icm/server_port_<n>`
    overrides it; `VCLIENT=0` breaks propagation whatever the global says.
11. `login/certificate_mapping_rulebased = 1` — after migrating any existing USREXTID
    entries with `CERTRULE_MIG`.
12. **CERTRULE** → import the sample certificate from step 3, create the rule.
    **It is client-dependent** — maintain it in the right client. Map to **Alias** or
    **E-Mail**, never **User Name**: ABAP user names are 12 characters, BTP identities
    are email addresses.
13. **SICF** → the BW paths must allow *Logon Through SSL Certificate*.
14. **SMICM** → Administration → ICM → Exit Hard → Global.

SNC is **not** involved — that is the RFC propagation path, not HTTPS.

## 3. The BW role

**SAP ships no display-only BW modeling role**, so one has to be built. Start from
`S_RS_RDEMO` (modeler template, stripped to display) or `S_RS_RDEBO` ("read
authorizations for BW metadata objects"), plus `SAP_BC_DWB_WBDISPLAY`. **Copy into `Z_*`
first** — SAP overwrites `SAP_*` roles on upgrade.

**BW read is ACTVT 03; write is ACTVT 23, not 02.** A role built by withholding `02`
still writes. Most `S_RS_*` objects also carry a `…PART` field separating *definition*
from *data*: grant `PART=definition` + `ACTVT=03` for metadata-only. The user needs at
least `Definition` merely to *see* an object in the tree.

| Object | Value |
|---|---|
| `S_ADT_RES` | `/sap/bw/modeling/*` (widen to `/sap/bc/*` only if a call 403s) |
| `S_BW4_REST` | `/sap/bw4/*` |
| `S_RFC` | ACTVT 16 on `SADT_REST_RFC_ENDPOINT`, `DDIF_FIELDINFO_GET`, `RFCPING`, `RFC_GET_FUNCTION_INTERFACE` |
| `S_TCODE` | `SADT_START_TCODE`, `SADT_START_WB_URI` |
| per-TLOGO | `S_RS_ADSO`, `S_RS_IOBJA`, `S_RS_DTP`, `S_RS_PC`, `S_RS_TRCS`, `S_RS_DS`, `S_RS_CPRO`, `S_RS_HCPR`, `S_RS_ODSV` at ACTVT 03 |

**Never grant `S_RS_ALL`** — it is a *profile*, effectively SAP_ALL for BW.

> After any role change run **RSOSM → Configure BW Search → Refresh**. `S_RS_*` changes
> are buffered for up to a day, and the symptom — objects missing from the tree — looks
> exactly like a missing authorization.

## 4. BTP destination

| Property | Value |
|---|---|
| `Type` | `HTTP` |
| `URL` | `http://<cc-virtual-host>:<port>` — **`http://`, see below** |
| `ProxyType` | `OnPremise` |
| `Authentication` | `PrincipalPropagation` |
| `CloudConnectorLocationId` | only if several Cloud Connectors serve the subaccount |

Do **not** set `User`/`Password`.

> **The `https://` trap.** SAP: *"the call from the cloud application must always use
> HTTP. If HTTPS is used, a 405 response will be returned."* An `https://` destination
> also makes the HTTP client tunnel with `CONNECT`, which silently drops the propagation
> headers before the proxy sees them — so the 405 says nothing about identity. The Cloud
> Connector still uses HTTPS to reach BW. The server rejects this configuration at
> request time rather than letting you debug the 405.

## 5. Deploy

```bash
cf create-service xsuaa        application bwmcp-xsuaa -c xs-security.json
cf create-service destination  lite        bwmcp-destination
cf create-service connectivity lite        bwmcp-connectivity

npm ci && npm run build          # dist/ is what ships; .cfignore excludes src/
cf push                          # edit manifest.yml first: BW_BTP_PP_DESTINATION, BW_CLIENT
```

`manifest.yml` ships placeholders. Note that values there **override** anything set with
`cf set-env` on the next push, so keep the manifest authoritative rather than patching
the deployed app.

Then assign the **BW MCP User** role collection — one collection, all 40 tools:

```bash
btp assign security/role-collection "BW MCP User" --to-user <email> --of-idp <idp>
```

Use the IdP the app actually logs in through (`sap.custom` on a subaccount with a custom
IAS tenant, **not** `sap.default`) — the wrong one gives `invalid_scope` with no other clue.

## 6. Connect a client

```
https://<app-route>/mcp
```

OAuth is fully discoverable — a client needs only that URL. It finds the authorization
server, registers itself dynamically, and sends the user through the normal browser login.

**Expect the first call to be slow.** BW initializes each ICF handler on first use:
around 70 s for discovery on an idle system, then sub-second. Each endpoint family warms
independently. `/health` does not touch BW, so the CF health check is unaffected.

## 7. When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| 401 + basic-auth popup; ICM trace `intermediary is NOT trusted -> remove SSL header fields` | ICM stripped `SSL_CLIENT_CERT` | step 9 — missing, mistyped, lowercase keyword, wrong spacing, or both variants set |
| `502 Principal propagation failed` | Destination service returned no auth header | check CERTRULE, and that the IdP is trusted + synchronized in the CC |
| `403 Access denied to resource … expose the resource correctly in your cloud connector` | path not exposed | step 7 — a CC message, not an authorization failure |
| `500 BW Search is not activated` on search / area browsing | BW Search off | RSOSM |
| `403 No service found for … RV_C_PCMLOG_CDS` on process-chain tools | OData services unpublished | `/IWFND/MAINT_SERVICE` |
| `404 Version 'M' … does not exist` | object exists only in the active version | affects tools reading the inactive draft; nothing to fix |
| `415 Requested content type … does not match back-end` | media-type mismatch | should not occur — the client takes versions from discovery; please report it |

Traces: SMICM → Goto → Trace → Level 2; CC loggers to All/Debug; SM50 → Taskhandler +
Security + ICF at level 2. SAP guides: KBA **3361376259** (propagation over HTTPS — the
main one), **3367280** (401 / credential popup), **3452851** (step-by-step setup),
**3371621** (common ICM parameter mistakes).

## Scope and limits

- **On-premise BW/4HANA only.** SAP BW Bridge works differently — no Cloud Connector for
  developer access, ABAP Cloud IAM instead of PFCG, no REST API for modeling objects, and
  principal propagation is not documented for it.
- **`/sap/bw/modeling` is an undocumented internal protocol.** It serves the Eclipse BW
  Modeling Tools; SAP publishes no contract and states no third-party support. Pin your
  BW support-package level and re-run `scripts/live-probe.mjs` after upgrades.
- **Tool availability varies by system** — the discovery document, BW Search, and which
  OData services are published all change what works. `scripts/live-probe.mjs` reports
  this for a given system.
- Two scopes exist internally: `read` (metadata) and `data` (`bw_query_data`,
  `bw_preview_datasource`, which return actual rows). The shipped collection grants both;
  for a metadata-only audience add a collection referencing `$XSAPPNAME.read` alone —
  out-of-scope tools then disappear from `tools/list` rather than failing on call.
