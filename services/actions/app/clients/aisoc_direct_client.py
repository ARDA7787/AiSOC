"""Stub async client for the AiSOC-direct osquery TLS endpoint.

This module satisfies the ``osquery_live_query`` playbook step contract in
PR 3 so that playbooks can reference ``backend: aisoc_direct`` without any
implementation yet.  The full implementation (including HTTP calls to the
``services/osquery-tls`` FastAPI service) will land in PR 4 once that service
is built.

Attempting to call :meth:`AiSOCDirectClient.live_query` in this stub will
raise :class:`NotImplementedError` with a descriptive message.  This surfaces
clearly in playbook dry-runs and CI before PR 4 ships.
"""

from __future__ import annotations

from typing import Any

from app.clients.osquery_allowlist import AllowlistError, render_query


class AiSOCDirectError(RuntimeError):
    """Raised when an aisoc-direct API call fails."""


class AiSOCDirectClient:
    """Stub client for the AiSOC built-in osquery TLS endpoint.

    .. note::

        **This is a PR-3 stub.**  The HTTP implementation will be added in PR 4
        once ``services/osquery-tls/`` is available.

    Parameters
    ----------
    base_url:
        Root URL of the ``services/osquery-tls`` FastAPI service, e.g.
        ``http://osquery-tls:8080``.  Ignored by the stub; preserved for
        interface compatibility with the real implementation.
    api_token:
        Bearer token for the osquery-tls service.  Ignored by the stub.
    verify_tls:
        Whether to verify TLS.  Ignored by the stub.
    poll_interval:
        Polling cadence in seconds.  Ignored by the stub.
    """

    def __init__(
        self,
        base_url: str,
        api_token: str,
        verify_tls: bool = True,
        poll_interval: float = 3.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_token = api_token
        self._verify_tls = verify_tls
        self._poll_interval = poll_interval

    async def live_query(
        self,
        target_hosts: list[str],
        template: str,
        template_params: dict[str, Any] | None = None,
        timeout_seconds: int = 60,
    ) -> dict[str, Any]:
        """Stub — always raises :class:`NotImplementedError`.

        Parameters
        ----------
        target_hosts:
            List of target host identifiers.
        template:
            Allowlist template ID (validated before the stub error is raised).
        template_params:
            Optional template parameters.
        timeout_seconds:
            Timeout; ignored by the stub.

        Raises
        ------
        AllowlistError
            If *template* is not in the approved allowlist (validated eagerly
            so that bad calls are caught even before PR 4 ships).
        NotImplementedError
            Always — the real implementation is forthcoming in PR 4.
        """
        params = template_params or {}
        # Validate allowlist eagerly; surfaces misconfigurations early.
        render_query(template, **params)

        raise NotImplementedError(
            "AiSOCDirectClient.live_query is a PR-3 stub. "
            "The full implementation will be added in PR 4 once "
            "services/osquery-tls/ is available."
        )
