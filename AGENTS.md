# Local project service

The Web app and Pi Runtime must be reachable from the user's host browser.
When starting or restarting this project through Codex on Windows, run
`npm run start` or `npm run restart` in `apps/web-prototype` with
`sandbox_permissions: "require_escalated"`. An isolated command sandbox can
bind the ports while the host browser cannot connect, and its background
processes may be removed when the command finishes. Do not use a temporary
`npm run dev` tool session as the persistent service.

After the launch command finishes, use a separate host command to run
`npm run status` and check HTTP 200 responses from the Web page at port 5173,
the Runtime health endpoint at port 5192, and `/api/health` through port 5173.
Startup log messages and port listeners alone do not establish availability.
Stop only processes verified as belonging to this project. Do not kill an
unknown port owner.
