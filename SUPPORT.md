# Support

## Before opening anything

The tool is best at diagnosing itself. Two commands answer most questions:

```bash
midflight doctor <your-session-file>   # can this log be read, and if not, which line breaks
midflight agents --probe              # which agent logs on this machine are actually readable
```

Both print the reason, not just a code. If either one already tells you what is
wrong, that answer *is* the fix.

## I have a session format midflight cannot open

That is the most useful issue you can file, and there is a template for it:
`.github/ISSUE_TEMPLATE/host_adapter_request.yml`. It asks only for the fields
needed to write an adapter. Please redact the log before attaching it — the
tool ships a redactor for exactly this:

```bash
midflight redact < raw-session.jsonl > safe-to-share.jsonl
```

## Questions and everything else

Open a discussion. "Is this normal?" questions about your own agent's behaviour
are welcome and are not off-topic — seeing how other people drive these tools
is the point of the project.
