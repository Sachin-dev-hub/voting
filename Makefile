.PHONY: build up down ps logs verify clean

build:   ## Build all images
	docker compose build

up:      ## Start the full stack (db, redis, backend, frontend, simulator)
	docker compose up -d

down:    ## Stop the stack (keeps the database volume)
	docker compose down

ps:      ## Show service status
	docker compose ps

logs:    ## Tail logs for a service, e.g. `make logs backend`
	docker compose logs -f --tail=100 $(filter-out $@,$(MAKECMDGOALS))

verify:  ## Check health + results endpoints
	@echo "--- healthz ---";            curl -s http://localhost:3000/healthz; echo
	@echo "--- results ---";            curl -s http://localhost:3000/api/results; echo
	@echo "--- manual vote (lion) ---"; curl -s -X POST http://localhost:3000/api/vote -H 'Content-Type: application/json' -d '{"animal":"lion"}'; echo

clean:   ## Stop the stack AND delete the database volume (fresh start)
	docker compose down -v