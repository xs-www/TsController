/**
 * 跨层共享的领域类型。
 *
 * 这里刻意不引入任何运行时依赖，只描述形状，便于测试中构造假实现。
 *
 * ## 路由身份是三元组：`(service, servePort, path)`
 *
 * - `service === null` 表示**节点级**路由：`https://<节点名>.<tailnet>.ts.net/<path>`，
 *   由 `tailscale serve --https=<port> --set-path=<path>` 写入。
 * - `service === 'svc:xxx'` 表示 **Tailscale Service 级**路由：
 *   `https://<xxx>.<tailnet>.ts.net/<path>`，由
 *   `tailscale serve --service=svc:xxx --https=<port> --set-path=<path>` 写入。
 *
 * 两个命名空间互不干扰：同一个路径可以同时挂在节点级与某个 Service 上。
 * 因此本文件里所有跨路由的匹配/去重/归属判断都必须带上 `service`。
 */

/** Docker 容器的发布端口。`hostPort` 缺失表示该端口未发布到宿主机。 */
export interface ContainerPort {
  /** 宿主机绑定地址，例如 "127.0.0.1" / "0.0.0.0" / "::"。 */
  hostIp: string;
  /** 宿主机端口。 */
  hostPort: number;
  /** 容器内部端口。 */
  containerPort: number;
  protocol: 'tcp' | 'udp' | 'sctp';
}

/** 归一化后的容器信息（只保留路由需要的字段）。 */
export interface ContainerInfo {
  id: string;
  /** 不含前导斜杠的容器名。 */
  name: string;
  image: string;
  /** Docker 状态字符串，例如 "running" / "exited"。 */
  state: string;
  /** 人类可读状态，例如 "Up 3 hours"。 */
  status: string;
  composeProject: string | null;
  composeService: string | null;
  createdAt: number;
  ports: ContainerPort[];
}

/**
 * Tailscale Service 名，形如 `svc:dsh`（**始终带 `svc:` 前缀**）。
 *
 * 外部来源可能写成 `dsh`，统一由 `normalizeServiceName()` 归一化后再进入领域层。
 */
export type ServiceName = string;

/** 映射目标的类别。 */
export type TargetKind =
  /** 关联到某个容器的已发布端口（可追踪容器生命周期）。 */
  | 'container'
  /** 关联到宿主机上的任意本机端口（例如 DSH、其它非容器服务）。 */
  | 'host';

/** 一条域名（路径）映射的目标。 */
export interface MappingTarget {
  kind: TargetKind;
  /**
   * 代理目标端口。
   *
   * `remoteHost` 为空时它是**本机**端口（serve 代理到 `http://127.0.0.1:<hostPort>`）；
   * 否则它是 `remoteHost` 那台机器上的端口。
   */
  hostPort: number;
  /** 追加到代理目标上的路径，"" 表示不追加。例如 "/api/agent"。 */
  targetPath: string;
  /**
   * 代理目标所在主机（可省略，省略即本机回环）。
   *
   * **Service 场景的关键字段**：Service host（tagged node，例如 NAS）可以代理到
   * 远端资源，例如 `--service=svc:dsh --https=443 http://my-laptop.example-tailnet.ts.net:3081`。
   * 此时 host 是 NAS，而资源在笔记本上，因此目标不能再写死 `127.0.0.1`。
   *
   * 取值只能是主机名或 IP（不带协议、不带端口）。
   */
  remoteHost?: string;
  /**
   * 代理协议；省略即 `http`。
   *
   * `https+insecure` 这类需要跳过证书校验的目标**不支持**——本工具不做 TLS 校验策略的登记。
   */
  scheme?: 'http' | 'https';
  containerId?: string;
  containerName?: string;
  containerPort?: number;
}

/** 一条映射在 serve 配置中占用过的路由位置。 */
export interface OwnedRoute {
  /** 所属 Service；`null` 表示节点级路由。 */
  service: ServiceName | null;
  /** 对外 HTTPS 端口。 */
  servePort: number;
  /** 挂载路径。 */
  path: string;
}

/** 指向 serve 中某个具体路由位置的引用（Service + 端口 + 路径）。 */
export type RouteRef = OwnedRoute;

/** TsController 持久化的映射记录。 */
export interface Mapping {
  id: string;
  /**
   * 该映射关联的 Tailscale Service；`null` 表示节点级路由。
   *
   * 非空时必须形如 `svc:dsh`。Service 由 admin console 定义、由某个 **tagged node**
   * 作为 host 对外 advertise——因此仅当当前节点是 Service host 时才能写入。
   */
  service: ServiceName | null;
  /** 归一化后的挂载路径，始终以 "/" 开头且无尾斜杠（根路径例外）。 */
  path: string;
  /**
   * 该映射挂在哪个对外 HTTPS 端口上。
   *
   * 端口是路由身份的一半：`/` 在 443 与 8443 上是两个互不干扰的独立入口。
   * 这也是「独立 origin」得以成立的原因——不同端口就是不同 origin，
   * 根绝对路径的静态资源因此天然正确。
   *
   * 对 Service 级路由，该端口必须与 Service 在 admin console 中定义的
   * endpoint（`tcp:<port>`）一致，否则写入后仍不会对外可用。
   */
  servePort: number;
  target: MappingTarget;
  note: string;
  enabled: boolean;
  /**
   * 该映射当前在 serve 配置中「占用」的位置集合。
   *
   * 存在的意义是路径/端口/Service 变更：变更后旧位置不再出现在
   * `service`/`path`/`servePort` 中，若不记账就会变成无人认领的孤儿 handler，
   * 继续把流量送进容器。
   */
  ownedRoutes: OwnedRoute[];
  createdAt: string;
  updatedAt: string;
}

/** 映射相对当前系统状态计算出的健康度。 */
export type MappingStatus =
  /** 已启用且 serve 配置与期望完全一致。 */
  | 'active'
  /** 已启用但 serve 配置缺失或指向别处，需要「应用」。 */
  | 'pending'
  /** 在 TsController 中被禁用，且 serve 配置中已无该路径。 */
  | 'disabled'
  /** 已禁用但 serve 配置里仍有残留（外部改动造成）。 */
  | 'disabled-drift'
  /** 目标端口没有任何运行中的容器发布（仅容器型映射会判定）。 */
  | 'orphaned-target'
  /** 该映射会暴露管理端口，被安全策略拒绝。 */
  | 'blocked'
  /** 期望路径被外部未托管路由占用，无法应用。 */
  | 'conflict'
  /**
   * Service 级映射：配置已写在 serve 里，但本节点尚未被承认/尚未 advertise
   * （等待管理员审批，或已被 drain）。对外暂时不可用。
   */
  | 'awaiting-approval';

/** 映射的运行时视图：持久化字段 + 实时状态。 */
export interface MappingView extends Mapping {
  status: MappingStatus;
  /** 期望写入 serve 的代理地址。 */
  desiredProxy: string;
  /** serve 配置中该位置当前实际指向的代理地址；未占用为 null。 */
  actualProxy: string | null;
  /**
   * 该映射对外的完整基址（不含路径），例如
   * `https://sisi-laptop.example-tailnet.ts.net`（节点级，非 443 会带端口）
   * 或 `https://dsh.example-tailnet.ts.net`（Service 级）。
   *
   * 无法确定主机名时为 null。
   */
  baseUrl: string | null;
  /** 面向用户的补充说明（例如目标容器已停止）。 */
  detail: string | null;
}

/** serve 配置中单个 handler 的解析结果。 */
export type ServeHandler =
  | {
      kind: 'proxy';
      /** 原始 Proxy 字符串。 */
      raw: string;
      /** 解析出的目标端口；无法解析时为 null。 */
      hostPort: number | null;
      /** 代理目标主机（不含端口）。 */
      host: string | null;
      /** 代理目标上追加的路径。 */
      targetPath: string;
      /** 是否指向本机回环地址。 */
      loopback: boolean;
      /** 是否由 Service 配置的 endpoint 语法（`http(s)://host:port`）解析而来。 */
      fromServiceConfig?: boolean;
    }
  | { kind: 'file' | 'text' | 'other'; raw: string };

/** serve 配置中的一条路由。 */
export interface ServeRoute {
  /** 这条 handler 所属的 Service；`null` 表示节点级路由。 */
  service: ServiceName | null;
  /** 这条 handler 所属的对外 HTTPS 端口。 */
  servePort: number;
  /**
   * serve 主机名（不含端口）。
   *
   * - 节点级：`<节点名>.<tailnet>.ts.net`
   * - Service 级：`<service 名>.<tailnet>.ts.net`（由 `get-config` 的目标推导，
   *   或由 Service 名 + MagicDNS 后缀拼出）
   */
  host: string;
  path: string;
  handler: ServeHandler;
  /** 是否已被 TsController 接管（存在于映射库中）。 */
  managed: boolean;
  /** 被接管时对应的映射 id。 */
  mappingId: string | null;
}

/**
 * 一个 Tailscale Service 在当前节点上的状态。
 *
 * 数据来源是 `tailscale serve get-config --all`（Service 端点配置）
 * 与 `tailscale status --json` 的 `Self.CapMap["service-host"]`（是否被承认）。
 */
export interface ServiceInfo {
  /** 形如 `svc:dsh`。 */
  name: ServiceName;
  /** Service 的 MagicDNS 名（不含端口），例如 `dsh.example-tailnet.ts.net`；无法确定时为 null。 */
  dnsName: string | null;
  /** 本节点配置里该 Service 的全部对外端口（来自 endpoint 的 `tcp:<port>`），升序。 */
  servePorts: number[];
  /** 本节点是否正在为该 Service 服务（`service-host` 能力命中，即已被承认/已 advertise）。 */
  advertised: boolean;
  /**
   * 该 Service 的 TailVIP（本节点需要监听的地址）；未知为空数组。
   *
   * 注意 TailVIP **不属于** `100.64.0.0/10`，且只能被动接受连接。
   */
  vipIps: string[];
}

/** `tailscale serve` 配置的归一化快照（节点级 + Service 级）。 */
export interface ServeSnapshot {
  /**
   * serve 中已声明的全部 HTTPS 端口（节点级与 Service 级合并），升序。
   *
   * 必须保留全部端口：早期实现只取与「默认端口」一致的那一组 `Web` 配置，
   * 导致挂在其它端口上的路由对 TsController 完全不可见——既管不了，
   * 安全闸门也扫不到。详见 `docs/static/function-index.md`。
   */
  httpsPorts: number[];
  /** 节点级 serve 主机名（例如 `my-laptop.example-tailnet.ts.net`）；无 Web 配置时为 null。 */
  hostname: string | null;
  /** 全部端口、全部命名空间上的路由，扁平存放，每条自带 `service`。 */
  routes: ServeRoute[];
  /** 当前节点上的全部 Service（含尚未被承认的）。 */
  services: ServiceInfo[];
}

/** 本机 tailnet 身份。 */
export interface TailnetInfo {
  /** 形如 "my-laptop.example-tailnet.ts.net"（无尾点）。 */
  dnsName: string | null;
  /** 形如 "https://my-laptop.example-tailnet.ts.net"；无 dnsName 时为 null。 */
  baseUrl: string | null;
  ips: string[];
  hostname: string | null;
  backendState: string | null;
  version: string | null;
  /**
   * MagicDNS 后缀，例如 `example-tailnet.ts.net`。
   *
   * Service 的对外名字是 `<service 名>.<MagicDNS 后缀>`，因此没有它就无法拼出
   * Service 的完整地址。
   */
  magicDnsSuffix: string | null;
  /**
   * 当前节点的 tag 列表（`tailscale status --json` 的 `Self.Tags`）。
   *
   * **为空即意味着本节点不可能成为 Service host**——这是 TsController 判定
   * 「Service 模式不可用」的唯一依据，用于在界面上直接给出原因而不是让用户
   * 对着一串 CLI 报错猜。
   */
  tags: string[];
  /** 本节点当前作为 host 服务的 Service 及其实例地址；键形如 `svc:dsh`。 */
  serviceHosts: Record<string, string[]>;
}

/** 安全审计事件，用于追踪「应用禁止暴露在 tailnet 中」的执行情况。 */
export interface AuditEvent {
  at: string;
  kind:
    | 'exposure-detected'
    | 'exposure-removed'
    | 'exposure-blocked'
    | 'apply'
    | 'import'
    | 'startup';
  message: string;
  detail?: Record<string, unknown>;
}
