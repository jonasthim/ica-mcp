Throwaway verification scripts. Run with `pnpm spike spike/<name>.ts`. They read `.env`
and write redacted JSON to `spike/out/` (gitignored). Findings are summarised in
`docs/api-notes.md`. Nothing here is imported by `src/`.
