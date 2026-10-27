## Running it

### With Docker (app + database)

```sh
docker compose up --build
```

Then open http://10.11.174.165 (port 80) or http://10.11.174.165:6767. This starts two containers: PostgreSQL (data kept in the `pgdata` volume) and the app (match logs kept in the `logs` volume). Stop them with `docker compose down`. Add `-v` to also delete the data.

### On the internet (https://ottv2.m2048.io)

The app is published through its own Cloudflare Tunnel, which connects out from this machine, so it needs no public IP or open ports. Cloudflare handles HTTPS.

1. In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel for OTTv2 and copy its token.
2. Add a published application to it: hostname `ottv2.m2048.io`, path empty, Service URL `http://app:6767`.
3. Put the token in `.env` (`TUNNEL_TOKEN=…`). `.env` also sets `PUBLIC_URL=https://ottv2.m2048.io` and `TRUST_PROXY=1`.
4. Start everything including the tunnel:

```sh
docker compose --profile tunnel up -d --build
```

The address on your network keeps working alongside it.