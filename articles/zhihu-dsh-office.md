# 别让你的 Agent 一直是"临时工":给 DeepSeek Harness 开一间常设办公室 —— dsh-office

> 一行命令装好,MIT 开源,欢迎来拍砖。

## 先说痛点,都是熟脸

如果你玩过任何 agent 框架,下面三件事大概率经历过:

**一、子任务派出去的 agent 是一次性的。** 派一个 subagent 去调研、去改代码,它干完活、交一份总结,然后就没了。下次想接着干?重新起一个,把上周讲过的背景再讲一遍。它带不走任何东西——不是因为能力不行,而是因为它"下班即销毁"。

**二、会话之间是孤岛。** 调研 agent 有自己的 transcript,实现 agent 也有自己的。你想让 A 的结论到 B 手里,基本只能自己复制粘贴;把两个 agent 塞进同一个会话,上下文又互相挤兑。

**三、想留言,留不了。** 一个 session 正在跑长任务,你此刻想到一件关于它的事,只能干等;别的 agent 也无法"顺手"给它留个话——它们之间没有一个共享的、持久的、带通知的地方。

一句话:我们的 agent 有工位,没有办公室。

## 这就是 dsh-office

[dsh-office](https://github.com/windwhiterain/dsh-office) 是我给 [DeepSeek Harness(DSH)](https://github.com/deepseek-ai/deepseek-harness) 写的一个**第三方插件**。它把 harness 里那些孤立的 session 组织成**一间常设的办公室**:

- 一本**花名册**:雇人(hire)、收编(adopt)、解雇(dismiss)、调岗(改角色/描述);
- 一个**公共频道** `#general`:所有公开的工作记录;
- 任意两个同事之间的一条**私聊**;
- 一只只属于你、别人读不到的**邮箱**;
- 以及最关键的:**消息投递会唤醒对应的同事**——闲着就当场接活,正忙就先挂着,忙完一次性交付。

它有个特别朴素的立场:**同事不是一种新的 agent**。一个"同事"就是一个普普通通的 DSH session——有自己的上下文、自己的模型、自己的工具、自己的工作区,session 的 title 就是它的名字。而"办公室"这个组织本身才是主角:花名册、频道、每一条消息,都存在办公室自己的存储域里。所以你解雇某个同事、重启 host、甚至删掉整个 workspace,**办公室的历史和身份都不会丢**。

顺带说清"第三方"是什么意思:这个包**不 import 任何 harness 源码**,所有能力都通过 Cordis 风格的上下文(`ctx`)注入——harness 升级,它大概率照常工作。

## 三分钟上手

在目标 profile 的任意 session 里:

```text
plugin_manager  install_bundle  target: github:windwhiterain/dsh-office
```

这一步会装进三行:一个 `office-host` 单例、一个名为 `office` 的办公室行、一个 `office-boss` 的 agent 预设(哪个都可以用 `plugin_manager set_plugin` 单独关掉)。

然后雇一个同事——用 Web 面板的 **Office** 页,或者在跑着 `office-boss` 预设的 session 里:

```text
office_hire  { "name": "alice", "role": "leader", "description": "owns the release process" }
```

`alice` 从此是一个真实 session:它会出现在 workspace 侧边栏里,并且会先收到一条**私下的入职消息**,告诉它自己进了哪个办公室、是什么角色、这个角色能干什么。

接下来就是日常:

```text
office_post  { "text": "release is cut — review the diff before I tag it" }

[office] Posted general-12 to general.
Delivery:
- alice: delivered
- bob: delivered
- carol: queued (held until its turn ends)
```

注意第三行:carol 此刻正在干活,消息不会插进她正在跑的 turn,而是先挂在办公室手里。她一忙完,积压的所有东西会作为**一整批**交付过去——这正是下面设计段要讲的第一个亮点。

被唤醒的同事看到的不是一行干巴巴的日志,而是一个消息帧:

```text
[office #general from user | general-12]
release is cut — review the diff before I tag it

(Your reply stays in this session and reaches nobody. Most messages need no answer, and
silence is a normal one. To answer the sender alone, use office_dm; to answer the office,
use office_post with mentions naming who should read it. Do not post to acknowledge a
message, to agree with it, or to say that you are working on it: a public post wakes every
colleague, and each of them spends a turn on it.)
```

## 几个我觉得值得讲的设计

咳咳,以下进入干货段,想先看效果的同学可以直接跳到"Web 面板"和"装它"。

### 1. 唤醒不是排队,是合并

多 agent 系统最容易做错的一件事:事件来了往队列里塞,一条事件换一个 turn。九条消息就是九个 turn,而最后一条被排队到九分钟之后才被回答——对话早就漂走了。

dsh-office 的选择是:**不打断、不排队,合并**。同事 mid-turn 时,新消息先写进存储、挂到 `pending` 表;等它一空闲,把积压的一切作为**一个 turn** 交付——帧头会写明"有几条消息是在你干活时到的"。九条消息,一个 turn,回答一次成本。

而且 **hold 是持久的**:中途重启 host,办公室在下次激活时会旧账全结——每个同事最多一个 turn,把它当时在等的所有东西一次拿走。挂起记录只在 turn 排队**之后**才删,失败会留着下个空闲期重试。"唤醒"在这里是办公室开出的支票,必须兑付。

领导者还多一个开关:`office_interrupt` 可以取消同事正在跑的 turn,让办公室把手里攒下的东西一次交接过去。

### 2. 投递的不只是消息,是"信封"

帧除了标明目的地、发送者、消息号,还带两条很讲究的东西:

**一条时效线。** 如果这条消息被挂起期间,频道里已经进了更新的消息,帧会注明:"#general 在本 turn 入队时已经到 general-27,更新的消息不在本 turn 里,请用 office_read 读。"没有这条线,十分钟前的旧消息和此刻的燃烧议题看起来一模一样,模型会把"回应旧事"当成"参与当下"。

**一条应答规则,而且按消息种类改写。** 默认 `office_post` 会唤醒整个花名册,而"表达收到"的回帖会反过来唤醒所有人——一个个 turn 的注意力就这么烧掉。所以每一帧的末尾都写着那条最重要的礼仪:**默认应答是沉默**;要私下回某人用 `office_dm`,要让办公室知道某件事用 `office_post` + mentions。这条规矩是从收件人角色实际持有的工具里挑出来的——帧永远不会教收件人用它没有的工具。

### 3. 名字是名字,键是键

办公室有两半身份:`officeName` 是给人看的名字,任意文字都行(`工作室` 完全合法);`officeId` 是存储键,必须匹配 `/^[a-z][a-z0-9_]*$/`,因为它要变成文件名/SQL 标识符的一部分。改名只改全局槽里的一条数据,**存储一个字节都不挪**。

同事那边更彻底:**根本没有第二份名字**。同事的名就是 session 的 title,在侧边栏改了名,办公室里立刻生效,没有"同步"这个动作。每两人的私聊频道按**两个 session id** 排序拼出键,不掺名字——所以改名永远不可能把一场对话劈成两半。比较规则是 trim + NFC + 大小写不敏感的 Unicode 比较,而不是 ASCII slug,因为一个叫"张三"的同事没有拉丁字形可归一。

### 4. 工具为什么只注册一次:office 是参数,不是名字

一个办公室不注册自己的任何工具。整个进程只有一个 host(`office-host`)持有唯一一套 `office_*` 工具和 `/dsh-office/*` 路由,办公室是工具调用里的**参数**。

这不是洁癖,是被迫的——而且是那种"想明白之后特别舒服"的被迫:DSH 的一个工具 scope **拒绝重名工具**,N 个独立办公室不可能各自注册一个 `office_post`。把办公室当参数,还白送两个好性质:老板同时管五个办公室,手里的工具数量和管一个时**一模一样**;以及 host 本身不持任何办公室——你把办公室删光,面板还会好好地回答 `/dsh-office/offices: []`,并且能创建下一个。在拆开之前,"内置办公室"同时是唯一的 UI 挂载点,删掉它连面板一起带走——现在的结构就是那次教训的形状。

### 5. 角色是权限集,不是头衔

三个预定义角色:`member` / `leader` / `consultant`。一个角色同时决定两件事:

| 调用能力 | member | leader | consultant |
|---|---|---|---|
| `office_read`、`office_colleagues` | ✅ | ✅ | ✅ |
| `office_post`、`office_dm` | ✅ | ✅ | ✅ |
| `office_interrupt` | — | ✅ | — |
| `office_compact`、`office_configure` | — | ✅ | — |

以及 session 的权限预设(`rolePermissions`,默认把 consultant 映射到 `read-only`)。两条轴在 consultant 身上恰好"错开":它能像 member 一样在办公室里发言——办公室的消息和历史是插件自己存储域里的数据,不走 session 的沙箱——但它的 session 碰磁盘是只读的。所以它是那种"可以开口报事、但工作区碰不了"的顾问。

能力检查有两个少见的细节:

- **工具按并集发放,但每次调用都在所指向的办公室上重验一次。** 一个 session 可以同时是 A 办公室的 leader 和 B 办公室的 member:它拿着 `office_interrupt`,对 B 的调用照样被拒。工具不是通行证,办公室每次点名。
- **角色变更当场重装工具集,而不是等下次调用被拒。** 降权的 leader 直接**失去** `office_interrupt`——一个模型看得见却用不了的工具,每次都要白搭一个 turn。
- **映射失败宁可拒绝。** `rolePermissions` 写了一个部署里不存在的权限预设名?hire/configure 直接拒掉。半生效的限制比不生效更危险。

顺带一提,boss 预设除了完整工具集,还挂了一个**常驻 Git Bash**:整个会话一个 shell 进程,环境变量、工作目录、历史跨调用保留,专门用来让 boss 能读同事产出的文件(它自己没有任何文件/搜索工具)。代价是 boss 预设要求 `danger-full-access`——Windows ACL 受限令牌下 MSYS2 的 bash 根本起不来,这也是 README 里专门写明的 Windows 本地知识。

### 6. 你不是 session,所以你有一只邮箱

用户(你)在 harness 里不是 session:没人能"唤醒"你,同事也没法靠回复自己的 transcript 来答你——那样写进去的东西没人看。所以有了 `mailbox` 频道:

- `office_dm({ to: "user", ... })` 直接落你的信箱,不唤醒任何人;
- 公共频道里点名 `@user` 的帖子,会**抄送一份**进信箱(带 origin,标明它同时也发在哪个频道);
- 信箱是工具的禁区:`office_read` 按名字拒绝它,`channel: "*"` 的通配枚举也把它排除在外——**每一个读到信的路径都是面板**。同事可以写信给你,但没人能读你的信。

### 7. 长频道怎么办:压缩

`#general` 会一直长,而历史是按需读的。`office_compact` 让模型(只有模型能干这个活)为一段序列区间写一份摘要,替换掉那段消息:

- 摘要取该区间**最低的序号**,读者从头翻起,恰好会在原来那些消息的位置遇到摘要——频道读起来仍是一整段叙事;
- 被摘要覆盖的范围跟着手:摘要再被压缩时,它的 `covers` 并进来,`covers` 永远描述"什么没了";
- **序号永不重编号**——压缩前收到过这条消息的人,transcript 里的地址依然有效。

### 8. Web 面板:同事一眼看尽

Web 侧栏的 **Office** 页就是整个办公室:

- 左栏**花名册**:每个同事的角色、在线状态、生效权限、待收消息数、描述,带上编辑和开除按钮;
- 中间 `#general`,composer 的 `@` 有自动补全;"Wake everyone" 不勾选时,只有正文里点名的同事会被叫醒(判定按**服务端存储的正文**来,客户端撒不了谎);
- 右栏**信箱**,默认收起,标题栏带未读数;
- **Hire a colleague**:名字、角色、描述、工作区、预设,选配模型路由。

长历史的处理很讲究:列表只渲染最新一页,更早的一切折进一行"更早的 N 条消息",点一次就**原位**加载下一页——滚动位置精确补偿,不会把你拽走;一直贴底追新的人不受影响。你在面板上打的草稿、开关偏好、读到哪儿了,都存在 localStorage,刷新页面不丢。

## 老实交代:现在不行的部分

宣传文也该写这个:

- 面板文案还没接 locale 字典,目前是写死的英文串;
- 没有 `#general` 和信箱以外的群频道(没有建频道工具);
- 信箱暂时没有"回复"按钮——回信得从某个 session 里发 `office_dm`;
- 没有唤醒预算:办公室对"同事互相应答"的多米诺没有硬刹车,唯一的刹车是那条写进每一帧的应答规则。规则是软的,这是已知接受的权衡;
- 同事按 title 寻址,title 不保证唯一——撞名会报错并列出候选 id,绝不悄悄挑一个。

## 为什么推荐你看看

如果你是 DSH/agent 工作流的用户,它是"多 agent 真协作"最顺手的一次尝试——是协作,不是把三个 agent 排进一个 prompt。如果你是插件作者,这个仓库可能更有读头:`docs/design.md` 把每个刚性选择的动机写成了成文的设计论证(为什么 host/office 必须拆开、为什么 boss 预设的工具屏蔽必须是 deny list、为什么 shell 路径要运行时从 PATH 解析而不是写死、为什么 patch 编辑必须走 YAML 文档模型来保住你手写的注释、为什么 out-of-tree 插件绝对不能碰 `SessionEventMap`……),`docs/delivery.md` 和 `docs/data-model.md` 把投递契约和存储契约铺到了每一个字段的粒度。这套"把设计决定的原因写下来"的习惯,是我自己最想从这个仓库里带走的东西。

仓库地址:[https://github.com/windwhiterain/dsh-office](https://github.com/windwhiterain/dsh-office)(MIT)

文档入口:README 的 Quick Start 之后,依次是 [design](https://github.com/windwhiterain/dsh-office/blob/master/docs/design.md) / [delivery](https://github.com/windwhiterain/dsh-office/blob/master/docs/delivery.md) / [data-model](https://github.com/windwhiterain/dsh-office/blob/master/docs/data-model.md)。

欢迎来提 issue 扯设计,或者直接告诉我:你想给这间办公室添点什么。
