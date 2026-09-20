# Laboratory -- Docker is the only dependency. `make` prints this.
-include .env
export
SHELL := /bin/sh
# Recursive on purpose. With `:=` this ran while make parsed the file, which on
# a cold machine is before `up` has started the sidecar: TS came out empty, the
# certificate recipe ran `docker run --network container:` with nothing after
# the colon, and the pin was never written. `=` re-reads it at each use, and
# every use is inside a recipe that runs after the sidecar is up.
TS = $(shell docker compose ps -q tailscale 2>/dev/null)

help:
	@printf 'Laboratory -- the datacenter test bench\n\n'
	@printf '  make up        join the tailnet, pin the WAF certificate, serve the bench on :$(or $(LAB_PORT),5180)\n'
	@printf '  make status    sidecar, relay and bench health in one screen\n'
	@printf '  make e2e       run the Playwright suite in Docker (report/ gets html + video)\n'
	@printf '  make report    open the last Playwright report\n'
	@printf '  make logs      follow every container\n'
	@printf '  make down      stop (state and certificate kept)   make clean: forget everything\n'

.env:
	@printf 'no .env: cp .env.example .env && chmod 600 .env, then fill it in\n'; exit 1

up: .env
	# --wait, not a bare `up -d`: the next line reaches the WAF *through* the
	# sidecar, and a sidecar that has started has not yet joined the tailnet.
	# Without the wait a cold machine failed the pin with "could not fetch the
	# WAF certificate", ~15 s before the tailnet was usable.
	docker compose up -d --wait tailscale
	$(MAKE) --no-print-directory relay/tls.conf
	docker compose up -d --build
	@$(MAKE) --no-print-directory status

# The WAF's certificate is self-signed (CN=localhost, an in-house CA), so
# the relay verifies against the chain it saw the first time -- a pin -- not
# against nothing. If the server does not hand out its issuer the pin cannot
# validate, and tls.conf says so and turns verification off rather than
# silently failing every request.
certs/waf.pem: .env
	@mkdir -p certs
	@docker run --rm --network container:$(TS) alpine/openssl s_client -showcerts -servername $(WAF_HOST) -connect $(WAF_HOST):$(WAF_PORT) </dev/null 2>/dev/null | awk '/BEGIN CERT/,/END CERT/' >certs/waf.pem.tmp
	@[ -s certs/waf.pem.tmp ] || { rm -f certs/waf.pem.tmp; printf 'could not fetch the WAF certificate from %s:%s through the tailnet\n' "$(WAF_HOST)" "$(WAF_PORT)"; exit 1; }
	@mv certs/waf.pem.tmp certs/waf.pem; printf '  pinned %s (%s certificate(s))\n' certs/waf.pem "$$(grep -c 'BEGIN CERT' certs/waf.pem)"

relay/tls.conf: certs/waf.pem
	@if docker run --rm --network container:$(TS) -v $(CURDIR)/certs:/certs:ro alpine/openssl s_client -servername $(WAF_HOST) -connect $(WAF_HOST):$(WAF_PORT) -CAfile /certs/waf.pem -verify_return_error </dev/null >/dev/null 2>&1; then \
	  printf 'proxy_ssl_verify on;\nproxy_ssl_trusted_certificate /certs/waf.pem;\nproxy_ssl_verify_depth 2;\n' >relay/tls.conf; printf '  relay verifies the WAF against the pinned chain\n'; \
	else \
	  printf 'proxy_ssl_verify off;\n' >relay/tls.conf; printf '  ! the WAF chain does not validate against its own pin (issuer not sent): relay TLS unverified\n'; \
	fi

status:
	@docker compose ps --format 'table {{.Service}}\t{{.Status}}'
	@printf 'tailnet: '; docker compose exec -T tailscale tailscale status --peers=false 2>/dev/null | head -1 || true
	@printf 'relay:   '; curl -s -m 10 http://localhost:$(or $(LAB_API_PORT),5174)/__lab/relay || printf 'not answering'; printf '\n'
	@printf 'gateway: HTTP '; curl -s -m 15 -o /dev/null -w '%{http_code}' http://localhost:$(or $(LAB_API_PORT),5174)/ || true; printf ' (404 is Kong: no route for /)\n'
	@printf 'bench:   http://localhost:%s   hostile origin: http://localhost:%s\n' "$(or $(LAB_PORT),5180)" "$(or $(LAB_HOSTILE_PORT),5181)"

e2e: .env
	@mkdir -p report
	docker compose --profile e2e run --rm e2e

report:
	@printf 'report/playwright/index.html\n'

logs:
	docker compose logs -f --tail=50

down:
	docker compose --profile e2e down

clean: down
	docker compose down -v --rmi local
	rm -rf certs relay/tls.conf report

.PHONY: help up status e2e report logs down clean
