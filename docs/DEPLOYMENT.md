# Deploying to SAP BTP Cloud Foundry with principal propagation

Read-only, per-user BW access: every MCP caller reaches BW as *themselves*, not as a
shared technical user.

**Start the SAP-side track first.** The Cloud Connector and ABAP steps below are the
long pole — they involve certificates, profile parameters and a role that SAP does
not ship. The `cf push` is the easy part.

---

## How the identity actually travels

```
MCP client --XSUAA JWT--> this app --X-User-Token--> Destination service
                                |
                                | SAP-Connectivity-Authentication
                                v
                        Connectivity proxy --> Cloud Connector
                                |
                                | short-lived X.509 in SSL_CLIENT_CERT
                                v
                        BW/4HANA  --CERTRULE--> ABAP user
```

Two things about this diagram cause most of the lost time:

1. **Two different certificates.** The Cloud Connector's *system certificate*
   establishes mTLS with BW. A separate *CA certificate* signs the short-lived
   per-user certificates. Configuring only the system certificate gives
   `IllegalStateException: No CA certificate available` — the classic first failure.
2. **Two different tokens on the wire.** `SAP-Connectivity-Authentication` carries the
   user; `Proxy-Authorization` authenticates this app to the connectivity proxy.
   `Authorization` is never sent — SAP reserves it for basic auth to the backend, and
   sending it breaks propagation.

---

## 1. Cloud Connector

1. **System Certificate** — import or generate. A self-signed one must have **no
   Subject Alternative Names** (CC ≥ 2.16.1 refuses to create them; regenerate older ones).
2. **CA Certificate** — PKCS#12, CSR, or self-signed. Must carry the `keyCertSign` key
   usage, or backends reject the client certificates it issues.
3. **Principal Propagation** — set a subject pattern, e.g. `CN=${login_name}`. Set
   *Certificate Validity (min)* deliberately low; the range is 0–43200 (30 days) and
   the CC caches and reuses certificates within it, so "short-lived" is a choice, not
   a guarantee. Then **Generate Sample Certificate** — that DER file is the input to
   CERTRULE in step 11.
4. **Backend Trust Store** — add the CA of BW's own server certificate, or the CC→BW
   handshake fails with `SunCertPathBuilderException`.
5. **Cloud to On-Premises → Principal Propagation tab → Synchronize**, and mark the
   issuing IdP **Trusted**. The trusted-IdP list is **empty by default**; skipping this
   gives `InvalidSSOTokenException`.
6. **Access Control entry**: Protocol **HTTPS**, *Allow Principal Propagation* ✓,
   Principal Type **X.509 Certificate**, *System Certificate for Logon* **off** (SAP's
   recommendation — lets PP and basic auth share one entry). Allowed paths:
   `/sap/bw/modeling/`, `/sap/bw4/`, `/sap/bc/http/sap/bw4/`, `/sap/opu/odata/sap/`.

Note the asymmetry: the **CC→BW leg is HTTPS**, the **app→CC leg is plain HTTP**. Both
are correct at once.

## 2. ABAP (BW/4HANA)

7. **STRUST** → SSL server Standard → import the **issuer** of the CC system
   certificate (the CA, not the system certificate itself unless self-signed) → *Add to
   Certificate List*. Full chain.
8. **`icm/trusted_reverse_proxy_<x> = SUBJECT="<subj>", ISSUER="<iss>"`**
   - `icm/HTTPS/trust_client_with_issuer` / `..._with_subject` are the **kernel ≤ 7.42**
     legacy pair.
   - **Setting both variants means BOTH are ignored** (SAP Note 2052899) — a silent,
     total loss of trust. This is widely misreported as "the new one wins". It does not.
   - `SUBJECT`/`ISSUER` must be **uppercase**; below kernel 7.53 the DN needs **blanks
     after commas** even though the CC UI shows none (Note 3335949, KBA 3371621).
   - It is a vector parameter — not editable via RZ11/SMICM before SAP_BASIS 816.
9. **`icm/HTTPS/verify_client`** = 1 (default). The per-port `VCLIENT=` on
   `icm/server_port_<n>` **overrides** it; `VCLIENT=0` breaks PP whatever the global says.
10. **`login/certificate_mapping_rulebased = 1`** — but migrate any existing USREXTID
    entries with **`CERTRULE_MIG` first**. SAP is explicit that migration precedes the flip.
11. **CERTRULE** — import the sample certificate from step 3, create the rule.
    **CERTRULE is client-dependent**: maintain it in the right client or it never
    matches. Map to **Alias** or **E-Mail**, never **User Name** — ABAP user names are
    12 characters and BTP identities are email addresses.
12. **SICF** — `/sap/bw/modeling`, `/sap/bw4/*` must permit *Logon Through SSL Certificate*.
13. **CRCONFIG** — CRL **strict mode** in profile `SSL_SERVER` is incompatible with
    X.509 identity propagation.
14. **SMICM** → Administration → ICM → Exit Hard → Global.

SNC is **not** involved. SNC is the RFC propagation mechanism; the HTTPS path is
mTLS/X.509 only. Guidance telling you to set the SU01 **SNC tab** for HTTPS PP is
conflating the two.

## 3. The BW role — you have to build it

**SAP ships no display-only BW modeling role.** The `SAP_BW4_*` set has six roles and
every one grants change or reporting. Build from `S_RS_RDEMO` (modeler template,
stripped to display) or `S_RS_RDEBO` ("read authorizations for BW metadata objects"),
plus `SAP_BC_DWB_WBDISPLAY`. **Copy into `Z_*` first** — SAP overwrites `SAP_*` roles on
upgrade.

**BW read is ACTVT 03; write is ACTVT 23, not 02.** A role built by withholding `02`
still writes. Most `S_RS_*` objects also carry a `…PART` subobject field separating
*definition* from *data* — for a metadata-only server grant `PART=definition` +
`ACTVT=03`. Note that the user needs at least `Definition` just to *see* an object in
the tree.

Authorization surface (SAP Note 1969032):

| Object | Value |
|---|---|
| `S_ADT_RES` | `/sap/bw/modeling/*` (start here; widen to `/sap/bc/*` only if a call 403s) |
| `S_BW4_REST` | `/sap/bw4/*` |
| `S_SERVICE` | the process-chain-monitoring OData services |
| `S_RFC` | ACTVT 16 on `SADT_REST_RFC_ENDPOINT`, `DDIF_FIELDINFO_GET`, `RFCPING`, `RFC_GET_FUNCTION_INTERFACE` |
| `S_TCODE` | `SADT_START_TCODE`, `SADT_START_WB_URI` |
| per-TLOGO | `S_RS_ADSO`, `S_RS_IOBJA`, `S_RS_DTP`, `S_RS_PC`, `S_RS_TRCS`, `S_RS_DS`, `S_RS_CPRO`, `S_RS_HCPR`, `S_RS_ODSV` at ACTVT 03 |

**Never grant `S_RS_ALL`** — it is a *profile*, effectively SAP_ALL for BW.

`S_DEVELOP` is very likely **not** needed: every `/sap/bc/adt/**` call was on a write
path and is gone from this build. Confirm with ST01/STAUTHTRACE rather than assuming.

> After any role change run **RSOSM → Configure BW Search → Refresh**. `S_RS_*` changes
> are buffered by BW Search for up to a day, and the symptom — objects invisible in the
> tree — looks exactly like a missing authorization. Two community threads diagnosed as
> authorization bugs were this.

## 4. BTP

Destination `BW4_PP`:

| Property | Value |
|---|---|
| `Type` | `HTTP` |
| `URL` | `http://<cc-virtual-host>:<port>` — **must be `http://`** |
| `ProxyType` | `OnPremise` |
| `Authentication` | `PrincipalPropagation` |
| `CloudConnectorLocationId` | only if several CCs serve the subaccount |

Do **not** set `User`/`Password`. `sap-client` is not a documented destination property
for PrincipalPropagation — it is `BW_CLIENT` in `manifest.yml` and is sent as a header.

> **The `https://` trap.** An `https://` destination makes the HTTP client tunnel with
> `CONNECT`, which drops *both* PP headers before the proxy sees them, and the Cloud
> Connector answers 405. Nothing in the error mentions identity. `createPerUserClient`
> rejects this at startup of the request rather than letting you debug the 405.

```bash
cf create-service xsuaa application bwmcp-xsuaa -c xs-security.json
cf create-service destination  lite bwmcp-destination
cf create-service connectivity lite bwmcp-connectivity

npm ci && npm run build     # dist/ is what gets pushed; .cfignore excludes src/
cf push
```

Then assign a role collection to your users:

- **BW MCP Model Viewer** — modeling metadata only (38 tools)
- **BW MCP Data Viewer** — adds `bw_query_data`, which returns actual BW data rows

The `data`/`read` split mirrors ARC-1's `allowDataPreview`: "may inspect the model" and
"may see the numbers" are different grants.

---

## When it does not work

The overwhelmingly most common symptom is **401 with a basic-auth popup**. In the ICM
trace:

```
HttpModIsReverseProxyTrustworthy: no trust relationship to intermediary specified
intermediary is NOT trusted -> remove SSL header fields
```

The ICM stripped `SSL_CLIENT_CERT`. Cause is almost always step 8 — parameter missing,
mistyped, lowercase keyword, wrong spacing, or both variants set at once. Healthy looks
like `intermediary is trusted -> forward SSL header fields`.

Traces: SMICM → Goto → Trace → Level 2; CC loggers to All/Debug (`ljs_trace.log` /
`scc_core.trc`); SM50 → Taskhandler + Security + ICF at level 2.

SAP guides: KBA 3361376259 (PP over HTTPS — the main one), 3367280 (401/credential
popup), 3452851 (step-by-step setup), 3371621 (common ICM parameter mistakes),
2701137 (Guided Answers).

## Known unknowns

- `/sap/bw/modeling` is an **undocumented internal protocol** — no published contract,
  no statement of third-party support. It serves the Eclipse BW Modeling Tools, which
  primarily tunnel ADT over *RFC*, not HTTP. Re-run the tool suite after any BW upgrade.
- There is **no SAP documentation** of BW Modeling Tools over Cloud Connector, or of
  principal propagation combined with ADT. Prove it with one destination, one CERTRULE
  rule and one GET before building on it.
- Whether `S_ADT_RES` needs `/sap/bc/*` for this build is untested; the sources disagree.

## BW Bridge is a different project

None of the above applies to SAP BW Bridge: no Cloud Connector for developer access,
service-key + browser logon instead, ABAP Cloud IAM business roles instead of PFCG, and
principal propagation is not documented for it at all. It also exposes no REST/OData API
for modeling objects. This deployment is **on-premise BW/4HANA only**.
