# Third-party notices

This extension bundles third-party material. Each item retains its own license.

## Denodo VQL syntax highlighting

- **Files:** `syntaxes/vql.tmLanguage.json`, `language-configuration.json`
- **Source:** [`denodo/denodocommunity-resources`](https://github.com/denodo/denodocommunity-resources/tree/master/plugins/denodo-vscode-vql-syntax)
  — *Denodo VQL Syntax Highlighting for VS Code* (the `denodo-vscode-vql-syntax`
  plugin, developed by Jason Sandidge at Denodo).
- **License:** MIT (the plugin's `package.json` declares MIT; the containing
  repository is licensed Apache-2.0). Reused with attribution.

The TextMate grammar `include`s VS Code's built-in `source.sql` grammar for base
SQL tokens, which is why the extension declares `vscode.sql` as an
`extensionDependency`.

The grammar file is vendored verbatim (its original
`information_for_contributors` header is preserved). No modifications were made to
the grammar rules.
