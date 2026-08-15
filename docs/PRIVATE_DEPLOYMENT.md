# Private deployment configuration

The private Worker configuration is intentionally local-only. Before running
private tests or deploying, copy `wrangler.private.example.jsonc` to
`wrangler.private.jsonc` and replace only the documented placeholders with the
values from your own Cloudflare account.

Never commit `wrangler.private.jsonc`. It contains account-specific hostnames
and Access audience identifiers. The Access service-token Client ID is supplied
through the `ACCESS_SERVICE_TOKEN_CLIENT_ID` Wrangler secret binding; the
Client Secret is used by the GitHub caller and is never configured on Bar.

The deployed boundary must retain all of these controls:

- `workers_dev` and `preview_urls` remain `false` for the private Worker.
- The custom hostname is covered by Cloudflare Access before deployment.
- Browser routes use an identity-based Access policy.
- `/api/v1/github/investigations` uses a Service Auth policy restricted to the
  current ingestion service token.
- `/api/v1/github/investigations/*/summary` uses its own Service Auth
  application and audience.

Use Cloudflare secret storage rather than a shell argument or committed file:

```sh
npx wrangler secret put ACCESS_SERVICE_TOKEN_CLIENT_ID \
  --config wrangler.private.jsonc
```

Before making the repository public, run the repository test suite and a
redacted full-history secret scan. A credential found in any commit must be
revoked; deleting it only from the latest tree is not sufficient.
