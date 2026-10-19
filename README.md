## Running it

### With Docker (app + database)

```sh
docker compose up --build
```

Then open http://localhost:6767. This starts two containers: PostgreSQL (data kept in the `pgdata` volume) and the app (match logs kept in the `logs` volume). Stop them with `docker compose down`. Add `-v` to also delete the data.