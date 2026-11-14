# Shared contracts

This workspace package contains dependency-free contracts shared across applications. `HttpErrorResponse` documents the public API error envelope, while `httpErrorResponse` is a small constructor for that shape. Error codes stay strings so each API module can define codes alongside its behavior.

The API currently emits the same envelope locally; wiring its handler to import this package is a follow-up integration step. This package does not contain persistence models, generated clients, or speculative job contracts.
