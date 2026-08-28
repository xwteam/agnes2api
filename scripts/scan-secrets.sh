#!/usr/bin/env bash
# 扫描仓库中是否混入真实凭据或私有部署细节。CI 与提交前均应运行。
#
# 用法：
#   bash scripts/scan-secrets.sh              # 只扫工作树；CI 里跑的就是这一档
#   bash scripts/scan-secrets.sh --history    # 工作树 + 可达历史里的每一个 blob
#
# ── 这道门禁已知的三格盲区，逐条写在这里 ─────────────────────────────────────
# **写清楚边界不是免责声明。** 下面三条每一条都还欠着东西，写在这里是为了让下一个
# 人看得见那笔账，不是为了说"已经写明所以不用管"。
#
# ① **不带 --history 时只扫工作树。** 一个凭据只要进过一个提交，哪怕下一个提交就把
#    它 `git rm` 掉，工作树这一档一个字都看不见——而 `git push` 发的是历史，不是工作
#    树。P3e 勘察用变异探针当场复现过：提交后再 `git rm` 提交，这个脚本仍然 exit 0。
#    ⇒ 历史那一档现在有了（`--history`），但**没有做成默认行为**：CI 的
#    `actions/checkout@v4` 默认 `fetch-depth: 1`，拿到的是浅仓，默认开启会让凭据扫描
#    那一步天天 fail closed（见下面的浅仓分支）。
#    ⇒ **今天的欠账**：没有任何自动化在跑 `--history`，它只在人手上。要还这笔账，
#    得先让 CI 那一步 `fetch-depth: 0`，再把 `--history` 加进去。
#
# ② **裸 IP 走第 6 条规则。** 第 5 条（`IP:PORT`）强制要有冒号和端口，于是一个不带
#    端口的服务器地址从它底下整个逃走——P3e 勘察实测的第二个盲区。第 6 条只认形态，
#    放行与否交给白名单，白名单逐条写清理由（见下面 `ip_allowed` 上方那一段）。
#    ⚠️⚠️ **两条规则各自独立，绝不许合并成「IP，端口可选」再统一过白名单**：回环
#    地址在白名单里，合并会一次性废掉 P3d 真实抓获过的「回环地址加端口」那一格。
#    这条边界由 tests/unit/scan-secrets.test.ts
#    的「(c) 保住旧能力：回环地址加 8791 端口那种写法仍然 exit 1」钉着。
#    ⇒ **今天的欠账**：白名单只按 CIDR 与字面量放行，它认不出"这个公网 IP 是不是本
#    仓真实部署地址"——那需要一份外部事实，本门禁不赌它。
#
# ③ **本脚本把自己排除在扫描外**（下面 `EXCLUDES` 里的 `':!scripts/scan-secrets.sh'`，
#    历史那一档按同一个路径过滤）。所以塞进本文件的凭据，本门禁自己看不见。
#    这既是白名单必须住在本文件里的原因（挪进单独的数据文件，就要为那个文件再开一个
#    排除，而那是一个新的、没人守的盲区），也是本门禁**已知且有意的最后一格盲区**。
#    ⇒ **今天的欠账**：没有任何东西守着这一格；要补只能另起一个不排除自己的扫描器，
#    而那会是第二份凭据判据。今天不补，账记在这里。
set -uo pipefail
cd "$(dirname "$0")/.."

MODE=worktree
case "${1:-}" in
  "")        ;;
  --history) MODE=history ;;
  *)
    # 认不出要吵，不能装没看见：手滑打成 `--histroy` 时静静跑成默认档，等于**以为
    # 扫了历史其实没扫**——那比不支持这个参数更糟。
    echo "❌ 认不出的参数「$1」。用法：scan-secrets.sh [--history]" >&2
    exit 2
    ;;
esac

PATTERNS=(
  'sk-[A-Za-z0-9]{20,}'
  'AC-[0-9a-f]{20,}'
  'mk_[A-Za-z0-9_-]{20,}'
  'g2a_[A-Za-z0-9_-]{20,}'
  '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}'
)
EXCLUDES=(':!scripts/scan-secrets.sh' ':!*.lock' ':!pnpm-lock.yaml')

# 第 6 条规则：**裸 IP**（第 5 条那个 `IP:PORT` 零白名单、一个字都没动，理由见文件头 ②）。
#
# 泄漏的那个私有部署地址正好落在「裸 IP」这一格：它没有端口，第 5 条正则抓不到。
# 但直接放开端口要求会在工作树里炸出成片命中（实测取值十余个）：多数是 RFC 5737 文档
# 保留段 / RFC 1918 私网 / 回环 / 八位组越界的非法地址；**另有两个是刻意选用的真实公网
# 地址** —— 1.2.3.4（APNIC 实际分配，出现在五语言 DEPLOY.md 正文里当 CF-Connecting-IP
# 示例）与 8.8.8.8（Google 公共 DNS）。
# ⇒ 无白名单 = 成片的红，这道门禁上线当天就会被 `--no-verify` 绕开。
#
# ⚠️ **理由段与白名单必须对得上号**：写成全称句「全部是保留段/回环/私网/非法地址」是
# 降级式描述，而下面的字面白名单其实分开列了那两个公网地址。对不上号的后果是：**下一
# 次有人往白名单里塞一个真公网 IP 时，没有任何一句话在拦他。**
#
# ⚠️ **白名单必须写在本文件内部**：上面 `EXCLUDES` 已经把本文件排除在扫描外，所以这里
# 写 IP 字面量不会自我命中。挪进单独的数据文件就要为那个文件再开一个排除。
BARE_IP='\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'
# **同一个形态的第二份写法，只给历史那一档的 gawk 用。**
# ⚠️ `\b` 在 gawk 的正则里是**退格**，不是词边界——把上面那一行照抄过去不会报错，它会
# 静静地变成另一个意思。所以这里不带边界断言，让它当一个**超集**：真正的边界由下面
# `extract_ips()` 的"极大段"判据来划，而放行判据（`ip_allowed`）**两档只有一份**。
# 这一条由 tests/unit/scan-secrets.test.ts
# 的「(e) 同一条裸 IP，工作树档与 --history 档给同一个答案」钉着。
BARE_IP_AWK='([0-9]{1,3}[.]){3}[0-9]{1,3}'

# 从任意文本里抽出「点分四段」：先把所有不是数字和点的字节换成换行，剩下的每一段都是
# 一个**极大**的数字点串，再要求整段恰好是四段 1–3 位数字。
# ⚠️ **极大段这一步不能省**：不加它，`2026.08.22.1` 这种日期写法会被从中间切出一个
# 假 IP 来（掐掉四位年份的头一位，剩下的三位正好凑成合法的第一段），凭空多一条假红。
# ⚠️ **这里刻意不把那个假 IP 逐字写出来**：写出来它就是一个不在白名单里的裸 IP 字面量，
# 只因为文件头 ③ 那格自我豁免才不会当场打红本文件——**一个安全扫描器不该在自己身上
# 攒下"只有靠自己的盲区才活得下去"的串**。（M2 变异实测：一旦路径过滤失效，
# 本文件立刻红在自己这行注释上。）
extract_ips() {
  tr -c '0-9.' '\n' | grep -xE '[0-9]{1,3}(\.[0-9]{1,3}){3}'
}

# 白名单。返回 0 = 放行，返回 1 = 这是一个该报的裸 IP。
#
# CIDR 白名单：127/8 回环、10/8 + 172.16/12 + 192.168/16 私网、
# 192.0.2/24 + 198.51.100/24 + 203.0.113/24 RFC 5737 文档保留段、0.0.0.0、255.255.255.255。
# 字面白名单：1.2.3.4（本仓通用占位，**是 APNIC 实际分配的真实公网地址**，
#   放行理由：它只出现在五语言 DEPLOY.md 的 CF-Connecting-IP 示例里，是公开文档惯用占位）、
#   8.8.8.8（Google 公共 DNS，**同样是真实公网地址**，放行理由：公开示例、非本仓部署）。
# ⚠️⚠️ **字面白名单只许放「公开文档示例地址」，新增一条必须在同一行写明放行理由**，
#   由 tests/unit/scan-secrets.test.ts
#   的「(d) 字面白名单里每一条都带放行理由」那格钉着（它连条数一起数）。
# 八位组 >255 直接判非 IP（吃掉 999.1.1.1 那类）。
ip_allowed() {
  local ip="$1" a b c d
  IFS=. read -r a b c d <<<"$ip"
  # `10#` 前缀：`08` 这种带前导零的段在 bash 算术里会被当八进制，直接报错退出。
  a=$((10#$a)); b=$((10#$b)); c=$((10#$c)); d=$((10#$d))
  (( a > 255 || b > 255 || c > 255 || d > 255 )) && return 0
  (( a == 127 )) && return 0
  (( a == 10 )) && return 0
  (( a == 172 && b >= 16 && b <= 31 )) && return 0
  (( a == 192 && b == 168 )) && return 0
  (( a == 192 && b == 0 && c == 2 )) && return 0
  (( a == 198 && b == 51 && c == 100 )) && return 0
  (( a == 203 && b == 0 && c == 113 )) && return 0
  (( a == 0 && b == 0 && c == 0 && d == 0 )) && return 0
  (( a == 255 && b == 255 && c == 255 && d == 255 )) && return 0
  [[ $ip == 1.2.3.4 || $ip == 8.8.8.8 ]] && return 0
  return 1
}

# 一整块文本里，所有不在白名单里的裸 IP（去重）。两档共用的**唯一**放行判据。
bad_ips_in() {
  local ip
  extract_ips <<<"$1" | sort -u | while IFS= read -r ip; do
    ip_allowed "$ip" || printf '%s\n' "$ip"
  done
}

fail=0

# ── 工作树档 ────────────────────────────────────────────────────────────────
# **评审 F3：这里原来带 `-I`，字面意思就是"跳过二进制文件"**——公开仓的
# "零内置凭据"门禁对着任何被 git 判定为二进制的跟踪文件完全失明（已实测：
# `storage-file.ts` 因为一个字面 NUL 字节被判成二进制之后，塞一段能匹配上面
# 任一条正则的假凭据进去，门禁照样放行）。去掉 `-I` 之后二进制文件里的疑似
# 凭据同样会被扫到（git grep 对二进制匹配只报"Binary file ... matches"，退出码仍是
# 0，因此会被下面 `case` 的 `0)` 分支捕获并让这一步失败）。`scripts/check-no-binary.mjs`
# 从根上不让这类文件存在，这里是第二道防线，两者缺一不可——
# 万一有人绕开或跳过 `scripts/check-no-binary.mjs` 那道门禁单独跑这个脚本，这里依然不会失明。
# **评审四审 B 组第 5 条：`git grep` 的退出码原来被静默吞掉。**
# 原来写的是 `if git grep …; then 命中; fi`——`git grep` 的约定是
#   0 = 有命中、1 = 没命中、**>1 = 出错**。`if` 只分"零/非零"，于是**出错被当成
#   "没命中"**，这个脚本照样打印 "✅ 未发现疑似凭据" 并 exit 0。这是一道安全门禁，
# 而我们刚刚才因为同一道门禁的 `-I` 盲区吃过一次亏（见上面），"扫不动"绝不能等于
# "扫干净了"。现在显式取退出码，只认 0 与 1 两种，其余一律 fail closed。
#
# ⚠️ **实测过的 >1 成因只有两类，都是 128**（评审五审必修 2：上一版这里把"索引损坏"
# 也列了进来，那是没实测就写下的猜测）：**坏的 pathspec**（`fatal: Invalid pathspec
# magic`）与 **`.git` 读不到 / 根本不在 git 仓库里**（`fatal: not a git repository`）。
# 破坏 `.git/index` **不**属于这一类——实测退出码 ≤ 1（`--untracked` 会退回去扫工作
# 树，植入的假凭据照样被抓到），安全性并没有因此受损。这里仍然对"任何 >1"fail
# closed，因为把成因列全本来就不是这段代码该赌的东西。
for p in "${PATTERNS[@]}"; do
  git grep --untracked -nnE "$p" -- "${EXCLUDES[@]}"
  status=$?
  case $status in
    0)
      echo "❌ 命中疑似凭据模式: $p" >&2
      fail=1
      ;;
    1) ;; # 没有命中，正常
    *)
      echo "❌ git grep 执行失败（退出码 $status），模式: $p —— 扫不动不等于扫干净，按失败处理" >&2
      fail=1
      ;;
  esac
done

# 第 6 条规则的工作树档：先用 `git grep` 把**候选行**找出来（形态判据是超集），
# 再逐行交给唯一那份放行判据。命中行照样打到 stdout，与上面五条同形。
ip_hits=$(git grep --untracked -nnE "$BARE_IP" -- "${EXCLUDES[@]}")
status=$?
case $status in
  0)
    while IFS= read -r line; do
      bad=$(bad_ips_in "$line")
      [[ -z $bad ]] && continue
      printf '%s\n' "$line"
      echo "❌ 命中不在白名单里的裸 IP: $(tr '\n' ' ' <<<"$bad")" >&2
      fail=1
    done <<<"$ip_hits"
    ;;
  1) ;; # 没有候选，正常
  *)
    echo "❌ git grep 执行失败（退出码 $status），裸 IP 规则 —— 扫不动不等于扫干净，按失败处理" >&2
    fail=1
    ;;
esac

# ── 历史档（只在 --history 时跑）────────────────────────────────────────────
if [[ $MODE == history ]]; then
  # 扫的是**可达**对象（`git rev-list --objects --all`），不是 `--batch-all-objects`。
  # ⚠️ **别把"不可达也扫"当加强**：`git add` 之后没提交、随后 reset 掉的 blob 会一直
  # 躺在盘上直到 gc，`git push` 永远不会发送它们。真仓盘上此刻就有一批这样的残渣（历
  # 次变异探针留下的，其中有带假凭据的），扫它们等于让这道门禁今天就红在噪音上，然后
  # 被人 `--no-verify` 绕过——那是把"警报淹掉信号"原样搬到安全门禁上。
  # 这条边界由 tests/unit/scan-secrets.test.ts
  # 的「(b) 反向控制：git add 假凭据但不提交、随后 git reset ⇒ --history exit 0」钉着。
  shallow=$(git rev-parse --is-shallow-repository 2>/dev/null)
  rc=$?
  if (( rc != 0 )); then
    echo "❌ --history: git rev-parse 失败（退出码 $rc）—— 这里不是一个能读的 git 仓库。历史不完整，按失败处理" >&2
    fail=1
  elif [[ $shallow != false ]]; then
    # 浅仓 fail closed。CI 的 checkout 默认 `fetch-depth: 1` 就是这一档——**在浅仓上
    # 报"历史干净"是这道门禁能犯的最坏的错**，它会让人以为历史被扫过了。
    echo "❌ --history: 这是一个浅仓（--is-shallow-repository = $shallow），拿不到全部历史。历史不完整，按失败处理" >&2
    fail=1
  else
    commits=$(git rev-list --all --count 2>/dev/null)
    rc=$?
    if (( rc != 0 )) || [[ -z $commits ]]; then
      echo "❌ --history: 数不出提交数（退出码 $rc）。历史不完整，按失败处理" >&2
      fail=1
    elif (( commits == 0 )); then
      echo "❌ --history: 这个仓库一个提交都没有，没有可扫的历史。历史不完整，按失败处理" >&2
      fail=1
    else
      # 六条规则合成一条超集正则交给 gawk 一次过：1067288 行的真仓实测 1.6 s。
      # `\.` 在动态正则里会被 gawk 降级成"任意字符"并打一条 warning，所以逐条换成 `[.]`。
      awkre=""
      for p in "${PATTERNS[@]}"; do awkre="${awkre:+$awkre|}(${p//\\./[.]})"; done
      awkre="$awkre|($BARE_IP_AWK)"

      # sha → 路径。路径过滤与工作树档的 EXCLUDES 一一对应（文件头 ③）。
      declare -A BLOB_PATH=()
      while IFS=$'\t' read -r sha path; do BLOB_PATH[$sha]=$path; done < <(
        git rev-list --objects --all \
          | git cat-file --batch-check='%(objectname) %(objecttype) %(rest)' \
          | LC_ALL=C awk '
              $2 != "blob" { next }
              {
                path = ""
                for (i = 3; i <= NF; i++) path = path (i > 3 ? " " : "") $i
                if (path == "scripts/scan-secrets.sh") next
                if (path == "pnpm-lock.yaml" || path ~ /\.lock$/) next
                print $1 "\t" path
              }'
      )
      if (( ${#BLOB_PATH[@]} == 0 )); then
        echo "❌ --history: 一个可扫的 blob 都没列出来。历史不完整，按失败处理" >&2
        fail=1
      else
        # `git cat-file --batch` 的输出是 `<sha> <type> <size>\n<内容>\n`。**按字节数
        # 自己分帧**（LC_ALL=C 下 length() 数的是字节），并且**分帧对不上就 fail closed**
        # ——错位之后 sha 会张冠李戴，而"报错了对象"比"没报"更难发现。
        hits=$(
          printf '%s\n' "${!BLOB_PATH[@]}" | git cat-file --batch | LC_ALL=C awk -v re="$awkre" '
            BEGIN { need = 0 }
            need <= 0 {
              if ($0 !~ /^[0-9a-f]{40} [a-z]+ [0-9]+$/) {
                print "分帧对不上，读到的不是对象头: " substr($0, 1, 60) > "/dev/stderr"
                exit 3
              }
              sha = $1; need = $3 + 1; ln = 0; next
            }
            {
              need -= length($0) + 1
              ln++
              # ⚠️ **整行原样往下传，绝不在这里截断**，两个理由都是实测撞出来的：
              # ① 判定在下游做，截断过的行会让**第 301 个字节之后的凭据整条消失**
              #    ——一道安全门禁 fail open，这是最坏的那一种；
              # ② LC_ALL=C 下截断是按字节切的，切在多字节字符中间会让下游 bash 的
              #    `read` **把下一条记录一起吞进来**（实测：两条命中并成一行，
              #    第二条的 sha 与路径当场丢失）。
              # 截断只在打印那一步做，用 bash 的 `${var:0:N}`（按字符切，不会切坏）。
              if ($0 ~ re) print sha "\t" ln "\t" $0
            }
            END { if (need > 0) { print "分帧在文件尾截断了" > "/dev/stderr"; exit 3 } }'
        )
        rc=$?
        if (( rc != 0 )); then
          echo "❌ --history: 遍历历史对象失败（退出码 $rc）—— 扫不动不等于扫干净，按失败处理" >&2
          fail=1
        elif [[ -n $hits ]]; then
          # 判定放在这里、不放在 awk 里：**放行判据只许有一份**（`ip_allowed`）。
          # 候选行可能上万，所以是"整块 grep 一次"而不是"逐行 grep 六次"。
          for p in "${PATTERNS[@]}"; do
            matched=$(grep -aE "$p" <<<"$hits")
            [[ -z $matched ]] && continue
            echo "❌ 历史里命中疑似凭据模式: $p" >&2
            while IFS=$'\t' read -r sha ln line; do
              echo "   ${sha:0:12} ${BLOB_PATH[$sha]:-?}:$ln: ${line:0:200}" >&2
            done <<<"$matched"
            fail=1
          done
          for ip in $(bad_ips_in "$hits"); do
            echo "❌ 历史里命中不在白名单里的裸 IP: $ip" >&2
            while IFS=$'\t' read -r sha ln line; do
              echo "   ${sha:0:12} ${BLOB_PATH[$sha]:-?}:$ln: ${line:0:200}" >&2
            done < <(grep -aF "$ip" <<<"$hits")
            fail=1
          done
        fi
      fi
    fi
  fi
fi

[[ $fail -eq 0 ]] && echo "✅ 未发现疑似凭据"
exit $fail
