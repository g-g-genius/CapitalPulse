# CapitalPulse

A 股行业板块、个股资金流向看板。项目采集行业板块及个股资金流数据，实时展示主力、超大单、大单、中单和小单的资金流向。

## 界面预览

![CapitalPulse 功能界面总览](frontend/overview.png)

## 功能特性

数据稳定性修复、验证步骤及上游限制见 [优化清单](docs/optimization-checklist.md)。

- 全行业实时扫描：主力资金累计按当日净流入前 15、净流出前 15 动态换榜
- 独立异动雷达：查看 15 秒、1 分钟、3 分钟资金变化及由负转正信号
- 全市场个股异动：独立扫描沪深京 A 股，按最近两轮主力资金变化展示流入、流出和由负转正；可跳转个股资金曲线
- 点击板块曲线或名称查看成分股短线活跃候选，并可跳转个股资金曲线
- 行业及个股细分资金流向监控
- 实时与历史数据可视化
- 邮箱注册、登录与退出，账号和会话保存在数据库中
- 自选股：登录后可从个股研究页一键加入，或在独立页面搜索添加；列表按账号保存在数据库，支持移除和直接查看资金走势
- 异动提醒：全行业与自选股短时资金信号、页面声音和桌面通知、按交易日历史回放
- MySQL 持久化，保留 SQLite 开发模式和历史数据迁移工具

## 项目结构

```text
CapitalPulse/
├── backend/
│   ├── routers/                    # REST API 路由
│   ├── services/                   # 行情采集、历史回填与持久化
│   ├── tests/                      # 后端单元测试
│   ├── utils/                      # 行业筛选等工具
│   ├── .env.example                # 后端环境变量模板
│   ├── config.py                   # 环境变量与上游接口配置
│   ├── main.py                     # FastAPI 入口
│   └── requirements.txt            # Python 依赖
├── frontend/
│   ├── public/                     # 静态资源
│   ├── src/app/                    # Next.js 页面与样式
│   └── .env.example                # 前端环境变量模板
├── bun.lock                        # Bun 依赖锁定文件
├── LICENSE
└── package.json                    # 项目命令与前端工作区配置
```

未配置 `DATABASE_URL` 时，开发模式仍使用 `backend/data/sector_flow_realtime.sqlite3`。配置 MySQL 后，板块与个股采集数据都写入 MySQL；原 SQLite 文件不会自动删除。

### 从 SQLite 迁移到 MySQL

1. 安装后端依赖：`python -m pip install -r backend/requirements.txt`。
2. 在 `backend/.env` 中设置 `MYSQL_ROOT_PASSWORD`、`MYSQL_PASSWORD` 和 `DATABASE_URL`，参考 `backend/.env.example`。连接串格式为 `mysql+pymysql://用户名:密码@主机:3306/数据库名`；密码中的 `@`、`#`、`/` 等字符需进行 URL 编码。生产环境可使用现有 MySQL 8 服务，先创建数据库及有建表权限的账号。
3. 如需本地 MySQL，启动 Docker Desktop 后，在项目根目录运行 `docker compose --env-file backend/.env -f compose.mysql.yml up -d`。Compose 仅将 3306 端口绑定到本机。
4. **先停止后端采集进程**，然后运行 `python backend/scripts/migrate_sqlite_to_mysql.py`。脚本会先生成一份 SQLite 一致性备份，再按批次把板块与个股历史数据写入 MySQL，重复运行不会覆盖已导入的记录。
5. 启动后端，用 `/api/health`、板块曲线及个股曲线核对数据。确认后保留 SQLite 备份一段时间，方便回退。回退时从 `backend/.env` 移除 `DATABASE_URL` 并重启后端。

MySQL 表在后端首次连接或执行迁移脚本时按 `backend/sql/mysql_schema.sql` 创建。当前没有运行中的 MySQL 服务时，迁移脚本无法完成导入；不要在此之前删除 SQLite 文件。

### 账号登录

打开 <http://localhost:3000/login> 注册或登录，工作台右上角也有账号入口。注册需要邮箱、昵称和至少 12 个字符的密码。密码使用 Argon2id 散列存储，会话保存在数据库中，浏览器使用 `HttpOnly`、`SameSite=Lax` Cookie。登录状态有效期为 7 天，退出后服务端会撤销该会话。

首次创建管理员时，在项目根目录运行 `python backend/scripts/create_admin.py`。脚本按当前 `backend/.env` 使用 MySQL 或 SQLite，默认账号为 `admin@capitalpulse.local`，随机初始密码只写入被 Git 忽略的 `backend/data/admin-credentials.txt`，不会输出到终端。请登录后妥善保存密码并删除该明文文件；普通注册账号始终是普通用户。管理员身份由服务端保存和校验，可用 `/api/auth/admin-check` 检查；管理后台功能尚未开发。

目前市场看板仍可公开查看；登录是账号基础功能，会员权限、支付和 AI 分析尚未接入。部署到 HTTPS 域名时，在后端环境变量中设置 `COOKIE_SECURE=true`，并把 `CORS_ORIGINS` 设置为实际前端来源。

登录后点击侧栏的“自选股”，可以搜索 A 股并添加到自己的列表；在“个股研究”页也可对当前股票点击“加入自选”。列表显示最新价、涨跌幅、主力净流入和由实际采集价格绘制的日内小走势。交易时段服务端每 10 秒批量采集已保存股票，按分钟保存价格点；刚加入时走势从第一个采集点开始，停牌或行情源异常时显示最近快照时间或空值，不填充虚构行情。每个账号最多保存 100 只，退出登录后列表不再显示。未登录时仍可使用公开行情与浏览器里的“最近查看”，自选股需要登录。

### 异动提醒与历史回放

侧栏“个股异动”与自选股提醒分开运行：仅在有人打开页面时，交易时段约每 60 秒读取一次东方财富沪深京 A 股完整分页；离开页面后停止扫描。页面按每只股票的上游源时间计算最近两轮及 1 分钟、3 分钟主力资金变化，列出本次有效快照数量、全市场总数、源时间和两轮实际间隔。分页不完整、资金字段缺失过多或源时间整体过期时会暂停更新并显示异常状态；停牌或交易稀疏的股票可能没有可用的短时变化。该雷达是盘中观察视图，目前不保存全市场个股秒级历史，也不生成全市场个股提醒；“异动提醒”里的个股提醒仍只针对账号自选股。全市场扫描会增加对东方财富的请求，若需要更快且有保障的全市场个股异动，应接入授权行情源。

侧栏“异动提醒”监测全行业，以及所有账号自选股中去重后的股票。板块沿用全行业快照采集；自选股在交易时段按批次约每 10 秒采集一次，无须打开某只股票的曲线。只有源时间距当前不超过 10 秒的快照会触发实时信号；断档超过 20 秒的样本不会被当作瞬时拉升。信号包括由负转正和连续两次满足条件的 15 秒资金加速，同一股票或板块、同一种信号 3 分钟内不重复提醒。

页面每 5 秒读取新信号。点击“声音”可开启提示音；点击“桌面通知”会请求浏览器权限。浏览器通知需要 HTTPS 或 localhost，工作台页面关闭后不会继续推送。灵敏与稳健两档保存在当前浏览器，仅影响该浏览器的提醒和列表筛选。初始服务端门槛为板块 15 秒加速 0.08 亿、由负转正 0.04 亿；自选股分别为 0.015 亿和 0.005 亿，后续可根据交易日复盘调整。

“历史回放”根据数据库中已保存的实时快照重新计算信号，并在有后续快照时显示信号发生后 1 分钟和 3 分钟的资金变化。回放不会生成新的实时提醒。过去未保存的秒级快照无法补出；从本版本开始，非当日 Top 30 的行业也会约每 15 秒保存一个快照，以提高以后全行业回放的覆盖率。这会增加数据库写入和存储量。

## 已安装依赖时启动（Windows PowerShell）

在项目根目录 `D:\Code\AI\CapitalPulse` 打开两个 PowerShell 窗口。先确认已按下文安装 Python 依赖、前端依赖并配置 `.env` 文件；如果使用 Conda，先在后端窗口执行 `conda activate capitalpulse`。

如果 `backend/.env` 配置了 `DATABASE_URL`，先启动 MySQL。本地 Docker 配置可在项目根目录执行 `docker compose --env-file backend/.env -f compose.mysql.yml up -d --wait`；MySQL 不可用时后端无法启动。

**窗口 1：启动后端**

```powershell
python -m uvicorn main:app --app-dir .\backend --host 127.0.0.1 --port 8000 --log-level warning
```

**窗口 2：启动前端**

```powershell
Set-Location frontend
bun run dev
```

浏览器打开 <http://localhost:3000/>。用 <http://localhost:8000/api/health> 检查后端是否运行；板块采集状态接口是 <http://localhost:8000/api/sector-flow/status>。前端会把 `/api/finance/*` 转发到后端的 `/api/*`，所以两个服务都要启动。

上述命令与本机实际成功运行的方式一致：从项目根目录用 `D:\Python3\python.exe -m uvicorn main:app --app-dir ./backend --port 8000` 启动后端；用 `D:\Programs\nodejs\node.exe frontend/node_modules/next/dist/bin/next dev frontend -p 3000` 启动前端。其他电脑请使用自己安装的 Python、Node.js 路径。

**重启：**前台运行时，在对应窗口按 `Ctrl+C` 停止，再执行上面的启动命令。前端开发服务会自动更新页面代码；后端按上述命令运行时，修改 Python 代码后需要重启后端。启动前若提示端口被占用，先用 `Get-NetTCPConnection -State Listen -LocalPort 3000,8000` 查看占用进程，并核对它是否属于本项目，避免重复启动。

需要关闭终端后继续运行时，可在项目根目录用下面的方式启动后台进程；日志会写入项目根目录：

```powershell
$projectDir = (Get-Location).Path
$pythonExe = (Get-Command python).Source
$nodeExe = (Get-Command node).Source
Start-Process -FilePath $pythonExe -ArgumentList @('-m','uvicorn','main:app','--app-dir','./backend','--port','8000','--log-level','warning') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput "$projectDir\api-runtime.log" -RedirectStandardError "$projectDir\api-runtime-error.log"
Start-Process -FilePath $nodeExe -ArgumentList @('frontend/node_modules/next/dist/bin/next','dev','frontend','-p','3000') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput "$projectDir\web-runtime.log" -RedirectStandardError "$projectDir\web-runtime-error.log"
```

收盘后页面保留最近的数据；板块实时采集会在下一个交易日恢复。

盘中每 3 秒轮询是本系统的请求频率，不代表东方财富每 3 秒提供新行情。页面按上游源时间判断新鲜度；超过 10 秒没有有效快照时会显示“数据延迟”，继续保留最近可用曲线，并暂停依赖新快照的短时提醒。`/api/health` 的 `data.status` 仅表示后端进程可用，`data.sector_flow.market_status` 和 `source_age_seconds` 才表示板块行情状态。主、备接口都属于东方财富，若需要有保障的秒级行情，应接入具有明确更新频率和服务承诺的授权数据源。

## 环境要求

| 软件 | 要求 | 说明 |
| --- | --- | --- |
| Anaconda 或 Miniconda | 较新的稳定版本 | 推荐体积更小的 Miniconda |
| Python | 3.11 | 通过独立 Conda 环境安装 |
| Node.js | 24 LTS 推荐，最低 20.9 | Next.js 16 最低要求 20.9；不要新装已结束支持的 Node.js 20 |
| Bun | 1.2 或更高版本 | 安装前端依赖和执行项目命令 |

目前项目仅在 Windows 上完成实际测试，已安装的软件可以跳过，但请先执行版本检查。

## Windows 部署

以下命令使用 PowerShell。安装 Conda 后，也可以在 Anaconda Prompt 中执行项目命令。

### 1. 安装 Miniconda 或 Anaconda

1. 打开 [Anaconda 下载页面](https://www.anaconda.com/download)。
2. 下载 Windows x86-64 的 Miniconda 安装程序；需要 Navigator 图形界面时可改装完整 Anaconda Distribution。
3. 运行安装程序，选择 `Just Me`，其他选项保持默认。
4. 安装完成后打开 Anaconda Prompt。

验证 Conda：

```powershell
conda --version
```

### 2. 安装 Node.js

1. 打开 [Node.js 下载页面](https://nodejs.org/en/download)。
2. 选择最新的 **LTS** 版本，下载 Windows Installer（`.msi`）。
3. 使用默认选项完成安装，然后重新打开终端。

验证 Node.js：

```powershell
node --version
npm --version
```

### 3. 安装 Bun

在 PowerShell 中执行 Bun 官方安装命令：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

关闭并重新打开 PowerShell，然后验证：

```powershell
bun --version
```

### 4. 创建 Python 环境

```powershell
conda create -n capitalpulse python=3.11 -y
conda activate capitalpulse
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

### 5. 配置环境变量并安装前端依赖

```powershell
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env.local
bun install --frozen-lockfile
```

按需编辑 `backend\.env` 和 `frontend\.env.local`。后端会自动读取 `backend\.env`

#### 后端：`backend/.env`

```dotenv
HOST=0.0.0.0
PORT=8000
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
COOKIE_SECURE=false

SECTOR_FLOW_ENABLED=true
SECTOR_FLOW_POLL_SECONDS=3
STOCK_FLOW_POLL_SECONDS=3
SECTOR_FLOW_DB_PATH=data/sector_flow_realtime.sqlite3
SECTOR_FLOW_RETENTION_DAYS=30
# DATABASE_URL=mysql+pymysql://capitalpulse:encoded-password@127.0.0.1:3306/capitalpulse
```

#### 前端：`frontend/.env.local`

```dotenv
VANE_API_URL=http://localhost:8000
# NEXT_PUBLIC_SECTOR_FLOW_WS_URL=ws://localhost:8000/ws/sector-flow
```

### 6. 启动开发环境

打开两个 PowerShell 或 Anaconda Prompt 窗口，两个窗口都进入项目根目录。

终端一启动后端：

```powershell
conda activate capitalpulse
bun run dev:api
```

终端二启动前端：

```powershell
conda activate capitalpulse
bun run dev:web
```

## 风险提示

本项目仅用于技术研究和数据展示，不保证数据的准确性、完整性与实时性，不构成任何投资建议。因使用本项目产生的交易、投资或其他损失，由使用者自行承担。

## License

本项目采用 [MIT License](LICENSE) 开源。

## 作者

- 小红书：[阿溪研究点啥](https://www.xiaohongshu.com/user/profile/62af3f61000000001902be20)

分享财经信息、实用工具和AI前沿，欢迎交流~
