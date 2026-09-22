---
title: "Self-host TypeRelay"
description: "Run TypeRelay locally for development or deploy the open-source production stack with the app, scheduler, MCP adapter, MongoDB, HTTPS, and SMTP."
---

# Development and deployment

`compose.yml` is development-only and includes source mounts, test tools and the dbh overlay. Development uses MongoDB and SMTP from dbh through terminal environment variables. `compose.prod.yml` is the open-source production stack with the app, MCP adapter, scheduler and persistent MongoDB. Production uses your own domains, HTTPS proxy and SMTP service.
