# Company chatbot: implementation plan

## Current POC scope

The POC is a Korean construction chatbot for official-law research. Its first
golden scenario is an excavation-work question. It helps the user find and read
the relevant official legal text; it does not decide that a particular document
is legally required.

The POC currently provides:

- A Next.js 16 UI that shows completed law-tool events and source links.
- A Node.js route that calls Upstage `solar-pro4` on the server only.
- `search_official_law` for candidate discovery across current laws and
  administrative rules.
- `read_official_law` for an exact candidate, optionally narrowed to a
  six-digit article number.
- Citation safety: search candidates are `citable: false`; only a successful
  read returns `citable: true` content and an official source.

## Current architecture

```text
Browser
  -> POST /api/chat { question }
  -> Next.js Node.js route
       -> Upstage Chat Completions (solar-pro4, server-only)
       -> tool loop (sequential, bounded)
            search_official_law
              -> 국가법령정보센터 search API
              -> candidates (citable: false) + request-local refs
            read_official_law(ref[, provision])
              -> 국가법령정보센터 read API
              -> official excerpt + source (citable: true)
  <- assistant answer + visible completed/failed tool events + source links
```

The route must require a tool on the first model turn. A model may read only a
reference produced by `search_official_law` in that same request. If no official
read succeeds, the response must withhold legal conclusions and direct the user
to the official text.

## Configuration

Set these server-side environment variables; do not expose either in browser
code, logs, commits, or documentation examples.

| Variable | Required | Purpose |
| --- | --- | --- |
| `UPSTAGE_API_KEY` | Yes | Authenticates the server-side Upstage request. |
| `LAW_GO_KR_OC` | Yes in production | Registered 국가법령정보센터 API OC. |
| `NODE_ENV` | Platform-provided | Enables the production configuration guard. |

`LAW_GO_KR_OC` is mandatory in production. Development may use the literal OC
`test` only when the variable is absent. Production must never fall back to
`test`.

For local development, place deployment-specific values in `.env.local` using
the variable names from `.env.example`, then restart `next dev`. Next.js loads
environment files when the server process starts. Never place credential values
in `.env.example`.

## Security and evidence rules

- Keep the Upstage API key and law API OC server-side. Never ship them to the
  client or place them in a user-facing answer.
- Accept a narrow request shape: one non-empty `question`, with length limits.
- Validate all model tool arguments and reject unknown fields.
- Keep law references request-local and reject invented or cross-request refs.
- Bound model turns, tool calls, upstream response size, retries, and timeouts.
- Use only official law-service content as legal evidence. Candidate metadata is
  navigation data, not a citation.
- Display each tool event, its status, and official source links so users can
  inspect how an answer was grounded.
- State that output is general information and requires confirmation against the
  current official text and, where appropriate, professional review.

## Acceptance gates

| Gate | Pass condition |
| --- | --- |
| Excavation golden scenario | The assistant searches a broad term such as `굴착면 작업계획서`, reads the selected official candidate, and avoids asserting required documents without a verified provision. |
| Citation integrity | Search output remains `citable: false`; every legal claim shown to the user has a successful `read_official_law` result and source metadata. |
| Reference isolation | A read using an unknown or prior-request ref fails safely. |
| Production configuration | A production request without `LAW_GO_KR_OC` returns a configuration failure and makes no law-service call. |
| Transparency | The UI shows completed or failed `search_official_law` and `read_official_law` events with official sources for completed results. |
| Secret handling | No API key or OC appears in client bundles, responses, logs, tests, or repository files. |

## Roadmap

1. **Stabilize the law POC.** Add automated coverage for the acceptance gates,
   including the excavation golden scenario, tool-argument validation, and
   production OC enforcement.
2. **Add company knowledge safely.** Introduce separate `search_company_docs`
   and `read_company_doc` tools with the same candidate-versus-read citation
   contract, document permissions, tenant isolation, and document provenance.
3. **Add opt-in web research.** Allow an optional approved-domain web-search
   tool only after domain allowlisting, source attribution, result-size limits,
   and a clear distinction between web material and official legal evidence.
4. **Validate before answering.** Add a post-retrieval compliance validator that
   checks evidence type, citations, source freshness, and unsupported legal
   claims before content reaches the user.
5. **Prepare an MCP extraction path.** Future MCP-based retrieval may extract
   law, company, or approved-web sources, but it must preserve these tool
   schemas, request-local references, citation flags, bounds, and secret/
   authorization controls.

## Design references (not dependencies)

These projects are research inputs only. The POC does not install, invoke, or
otherwise depend on them.

- [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)
  — Korean-law MCP interface patterns.
- [tjdwls101010/MOLEG-API](https://github.com/tjdwls101010/MOLEG-API) —
  Ministry of Government Legislation API integration ideas.
- [brave/brave-search-mcp-server](https://github.com/brave/brave-search-mcp-server)
  — optional web-search MCP design reference.
- [exa-labs/exa-mcp-server](https://github.com/exa-labs/exa-mcp-server) —
  optional web-search MCP design reference.

## Verification commands

Run these before merging changes that affect the chatbot:

```bash
npm run typecheck
npm run lint
npm run build
```
