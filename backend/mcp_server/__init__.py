"""
ConsultancyDev MCP server.

An MCP (Model Context Protocol) server that exposes the CRM's REST API to AI
clients. It never touches the ORM: every tool is an HTTP call to /api/ made as
the authenticated user, so role, tenant and ownership rules stay where they are
enforced.
"""

__version__ = '1.0.0'
