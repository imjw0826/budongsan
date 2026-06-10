# 배포 가이드

## ✅ 현재 배포: GitHub Pages (서버리스, 무료)

**라이브 URL**: https://imjw0826.github.io/budongsan/

데이터가 읽기 전용(반기 갱신)이라 서버 없이 정적 사이트로 배포한다.
단지별 가격 JSON 3,367개(~157 MB)를 빌드 시 미리 생성해서 gh-pages 브랜치로 푸시.

```bash
npm run deploy   # build:pages(정적 export 포함) + gh-pages 브랜치 푸시
```

구성 요소:
- `scripts/export-static-api.mjs` — SQLite → `dist/api/meta.json` + `dist/api/apartments/{id}.json`
- `vite.config.ts` — `DEPLOY_BASE=/budongsan/` 시 base 경로 적용
- `dist/404.html` — SPA 딥링크(`/complex/:id`) fallback (index.html 복사본)
- Express(`server/api.mjs`)는 **로컬 개발 전용**으로만 사용

데이터 갱신 후 재배포: `npm run import:vworld -- --shp --csv && npm run build:complexes && npm run deploy`

---

# (대안) Oracle Cloud Always Free — 서버 호스팅이 필요해질 때

> **목표**: 24/7 무중단, 영구 0원, 면접 포트폴리오 URL 1개.
> **하드웨어**: Oracle Cloud Ampere ARM (2 OCPU / 12 GB RAM / 50 GB SSD).
> **소요 시간**: 가입 + 셋업 약 60~90분 (SQLite 업로드 시간 제외).
>
> **현재 스택**: React SPA + Leaflet 1.9.4 + CARTO Positron 래스터 타일 (외부).
> 자체 호스팅 데이터: `data/budongsan.sqlite` (~330 MB) + `public/boundaries/` (1.4 MB, 자치구·동·아파트 위치만). 도로·건물·공원·강 등 배경 지도는 전부 CARTO 가 PNG 로 제공 — **서버 디스크가 들고 있을 필요 없음**.
>
> ✅ 이전(MapLibre+자체 MVT) 대비 변화:
> - 클라이언트 번들 1.22 MB → **360 KB** (gzip 110 KB), 첫 로딩 빠름
> - `dist/` 출력 ~30 MB → **1.9 MB** (8.5 MB MVT 타일 피라미드 제거)
> - `vite build` 596 ms → **241 ms**
> - 외부 의존성 1개 추가: `*.basemaps.cartocdn.com` (CARTO Positron 타일 CDN)

---

## 0. 미리 준비

- [ ] 신용/체크카드 (인증용, 청구는 발생하지 않음 — Always Free 등급은 결제 구조적으로 불가)
- [ ] SSH 공개키 — 없으면 `ssh-keygen -t ed25519` 한 번 실행해서 `~/.ssh/id_ed25519.pub` 생성
- [ ] (선택) 무료 도메인용 GitHub 계정 — DuckDNS 가입에 사용

---

## 1. Oracle Cloud 가입

1. https://cloud.oracle.com/ 에서 **Sign up for free** 클릭
2. **Home Region 은 Tokyo (NRT) 또는 Osaka (KIX) 선택**
   > ⚠️ Seoul (ICN) 은 ARM Ampere capacity 가 거의 항상 가득 차서 VM 생성이 실패함. 일본 region 도 한국에서 latency 30 ms 수준이라 체감 차이 없음.
3. 카드 등록 (USD 1달러 hold 후 환불됨)
4. 가입 직후 30일 trial credits 가 자동 부여됨 — **무시해도 됨**. Always Free 리소스는 trial 종료 후에도 살아있음.

---

## 2. ARM Ampere VM 생성

Console → **☰ → Compute → Instances → Create instance**

| 필드 | 값 |
|---|---|
| Name | `budongsan` |
| Image | **Canonical Ubuntu 24.04 (aarch64)** 로 변경 — 기본은 x86_64 |
| Shape | **Change shape → Ampere → VM.Standard.A1.Flex** |
| OCPU | `2` |
| Memory | `12 GB` |
| Boot volume | 기본 47 GB (200 GB 까지 무료) |
| Networking | 기본 VCN 자동 생성 |
| **Add SSH keys** | `~/.ssh/id_ed25519.pub` 내용 붙여넣기 |

**Create** 클릭.

### ⚠️ "Out of capacity" 에러 대처
- **Availability Domain** 드롭다운에서 AD-1 → AD-2 → AD-3 차례로 시도
- 그래도 실패하면 30분~몇시간 후 재시도 (또는 다른 region)
- 처음부터 4 OCPU/24 GB 짜리 큰 거 만들지 말고 **2 OCPU/12 GB 부터** (성공률 ↑)

생성 완료되면 **Public IP** 메모. 예: `132.226.123.45`

---

## 3. 네트워크 포트 개방 (2단계 필수)

Oracle ARM Ubuntu 는 80/443 이 **두 군데** 막혀있음. 둘 다 열어야 외부에서 접속됨.

### 3a. VCN Security List

Console → **Networking → Virtual Cloud Networks → vcn-... → Security Lists → Default Security List for vcn-...**

**Add Ingress Rules** 클릭, 두 개 추가:

| Source CIDR | Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

### 3b. OS 내 iptables 도 개방

```bash
ssh ubuntu@132.226.123.45   # ← 본인 Public IP

sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

확인:
```bash
sudo iptables -L INPUT -n --line-numbers | head -10
# 80, 443 ACCEPT 라인이 보이면 OK
```

---

## 4. 런타임 설치

```bash
# Node.js 22 (ARM 빌드 자동 선택)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git build-essential python3

# Caddy (자동 HTTPS 리버스 프록시)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# 설치 확인
node -v          # v22.x
caddy version
```

---

## 5. 코드 + 데이터 배포

### 5a. 서버에서 코드 받기

```bash
cd ~
git clone https://github.com/imjw0826/budongsan.git
cd budongsan
npm ci                  # better-sqlite3 가 ARM 으로 컴파일됨 (1~2분)
npm run build           # dist/ 생성 (~1.9 MB, 200~300 ms)
mkdir -p data
```

> 💡 빌드 산출물과 SQLite(~330 MB)를 합쳐도 1 GB 미만이라 VM 부트 디스크에 여유가 큽니다. CARTO 가 타일을 대신 제공하기 때문에 `public/tiles/` 같은 대용량 디렉토리를 서버에 둘 필요가 없어요.

### 5b. 로컬에서 SQLite 업로드

```bash
# 본인 맥에서 — ~330 MB, 회선 따라 1~5분 소요
rsync -avP --partial data/budongsan.sqlite \
  ubuntu@132.226.123.45:~/budongsan/data/
```

> 💡 `rsync --partial` 은 끊겨도 이어받기 가능. `scp` 는 끊기면 처음부터 다시 받음.

업로드 후 서버에서 확인:
```bash
ls -lh ~/budongsan/data/budongsan.sqlite   # 2.6 GB 보여야 함
```

---

## 6. systemd 서비스 등록

```bash
sudo tee /etc/systemd/system/budongsan.service > /dev/null <<'EOF'
[Unit]
Description=budongsan api
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/budongsan
ExecStart=/usr/bin/node server/api.mjs
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=API_PORT=8000

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now budongsan
sudo systemctl status budongsan      # active (running) 확인
```

로그 모니터링: `journalctl -u budongsan -f`

---

## 7. Caddy — 정적 + API 한 번에 + HTTPS 자동

### 옵션 A — 도메인 없이 IP 만 사용 (HTTP)

> ⚠️ **HTTP 만 쓰면 CARTO 타일이 mixed-content 로 차단될 수 있음.** CARTO 는 항상 `https://` 인데 페이지가 `http://` 이면 모던 브라우저가 일부 케이스에서 막아요. 가능하면 옵션 B(HTTPS) 추천.

`/etc/caddy/Caddyfile`:
```caddy
:80 {
  root * /home/ubuntu/budongsan/dist
  encode gzip zstd
  file_server
  handle /api/* {
    reverse_proxy 127.0.0.1:8000
  }
  try_files {path} /index.html
}
```

```bash
sudo systemctl reload caddy
```

→ `http://132.226.123.45` 접속.

### 옵션 B — 무료 도메인 + 자동 HTTPS (포트폴리오 추천)

**DuckDNS 무료 서브도메인** 사용:

1. https://www.duckdns.org → GitHub 로그인
2. subdomain 생성 (예: `budongsan`)
3. `current ip` 칸에 VM Public IP 입력 → **update ip**
4. 1~2분 후 DNS 전파됨

`/etc/caddy/Caddyfile`:
```caddy
budongsan.duckdns.org {
  root * /home/ubuntu/budongsan/dist
  encode gzip zstd
  file_server
  handle /api/* {
    reverse_proxy 127.0.0.1:8000
  }
  try_files {path} /index.html
}
```

```bash
sudo systemctl reload caddy
journalctl -u caddy -f          # Let's Encrypt 인증서 발급 로그 확인
```

1~2분 내 자동 HTTPS 완료. `https://budongsan.duckdns.org` 접속.

> 💡 본인 도메인 `.com` 을 산다면 (1만원/년) namecheap·가비아에서 A 레코드를 VM IP 로 가리키기만 하면 됨. Caddyfile 의 도메인만 바꿔주면 끝.

---

## 8. 업데이트 워크플로

로컬에서 `git push` 후, 한 줄로 서버 갱신:

```bash
ssh ubuntu@132.226.123.45 'cd budongsan && git pull && npm ci && npm run build && sudo systemctl restart budongsan'
```

로컬에 `deploy.sh` 로 저장:
```bash
#!/usr/bin/env bash
set -euo pipefail
ssh ubuntu@132.226.123.45 'cd budongsan && git pull && npm ci && npm run build && sudo systemctl restart budongsan'
```
```bash
chmod +x deploy.sh
```
이후엔 `./deploy.sh` 한 번으로 배포 끝.

---

## 9. 안전망 (선택, 면접 +α)

### 9a. 자동 보안 업데이트
```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### 9b. SQLite 일일 백업 (7일 보관)
```bash
mkdir -p /home/ubuntu/backups

sudo tee /etc/cron.daily/budongsan-backup > /dev/null <<'EOF'
#!/usr/bin/env bash
sqlite3 /home/ubuntu/budongsan/data/budongsan.sqlite \
  ".backup '/home/ubuntu/backups/budongsan-$(date +%F).sqlite'"
find /home/ubuntu/backups -name 'budongsan-*.sqlite' -mtime +7 -delete
EOF
sudo chmod +x /etc/cron.daily/budongsan-backup
```

### 9c. fail2ban (SSH brute-force 차단)
```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

---

## 10. ⚠️ 외부 의존성 (CARTO) 메모

배경 지도 타일이 `*.basemaps.cartocdn.com` 에서 옵니다 (OSM 데이터를 CARTO 가 미리 렌더해둔 PNG). 이 때문에:

- **사이트 자체는 CARTO 가 죽어도 무너지지 않음** — 자치구 outline + 가격 칩은 우리 데이터라 정상 표시. 흰 배경에 행정구역 윤곽만 뜸.
- **사용량 한도**: CARTO 무료 정책은 비상업·소규모 트래픽 OK. 면접 포트폴리오 수준이면 한도 안 넘음 (참고: backrooms.kr 도 같은 타일 쓰는 중).
- **걱정되면 동일 스타일 자체 호스팅 가능**: OpenMapTiles + planetiler 로 한국만 빌드하면 약 200 MB. 우리 VM 디스크 50 GB 에 가뿐. 필요해지면 그때 옮기면 됨.

---

## 11. ⚠️ 영구 무료 유지 체크포인트

| 시점 | 해야 할 일 |
|---|---|
| **가입 후 30일** | Console 상단 "Upgrade to Pay As You Go" 배너 → **무시**. 자동으로 Always Free 등급만 남음. |
| **60일 idle 시** | "재활용 통보" 메일 발송. 24/7 트래픽이 있으면 해당 없음. 안 쓸 거면 한 번씩 SSH 접속해서 활동 로그만 남기면 됨. |

---

## 최종 체크리스트

- [ ] Tokyo/Osaka region 에 ARM A1.Flex 2 OCPU / 12 GB VM 생성됨
- [ ] Public IP 확보
- [ ] VCN Security List 에 80/443 인그레스 추가
- [ ] VM 내부 iptables 에도 80/443 ACCEPT
- [ ] Node 22 + Caddy 설치
- [ ] `git clone` + `npm ci` + `npm run build` 성공
- [ ] `data/budongsan.sqlite` 업로드 완료 (2.6 GB)
- [ ] `systemctl status budongsan` → **active (running)**
- [ ] DuckDNS 또는 도메인 A 레코드 → VM Public IP
- [ ] Caddyfile 작성 + `systemctl reload caddy`
- [ ] 브라우저에서 `https://budongsan.duckdns.org` 정상 표시
- [ ] **가입 30일 후 자동으로 Always Free 만 남는 거 확인**

→ 이 시점부터 **영구 0원, 24/7 가동**.

이력서·포트폴리오에 "AWS t4g.xlarge (4 vCPU/24 GB ARM Ampere) 급 인프라 무중단 운영" 적어도 부풀린 거 아님 — 동급 AWS 인스턴스 시간당 ~$0.13.

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `https://...` 접속 시 timeout | VCN Security List 80/443 누락. 섹션 3a 재확인. |
| 같은 timeout 인데 VCN 은 열려있음 | OS iptables 가 막음. 섹션 3b 재실행. |
| Caddy 가 인증서 발급 실패 | DuckDNS IP 가 VM IP 와 일치하는지 확인. DNS 전파 1~5분 대기. |
| `npm ci` 가 better-sqlite3 빌드 실패 | `build-essential python3` 누락. 섹션 4 재확인. |
| `systemctl status budongsan` 가 failed | `journalctl -u budongsan -n 100` 으로 로그 확인. 대부분 `data/budongsan.sqlite` 경로 또는 권한 문제. |
| `Out of capacity` 가 반복 | Region 변경 (NRT ↔ KIX) 또는 OCPU 1/Memory 6 GB 로 줄여서 시도. |
| SCP/rsync 가 자꾸 끊김 | `rsync -avP --partial` 사용. 끊기면 같은 명령 재실행하면 이어받음. |
| 지도 배경이 회색만 보이고 도로·건물이 안 뜸 | CARTO 타일 차단. 브라우저 DevTools Network 에서 `basemaps.cartocdn.com` 가 200 인지 확인. mixed-content (HTTP 페이지) 또는 사내망 방화벽이 원인. |

막힌 단계가 있으면 해당 섹션 번호와 함께 알려주세요.
