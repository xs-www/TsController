/**
 * 跨层共享的领域类型。
 *
 * 这里刻意不引入任何运行时依赖，只描述形状，便于测试中构造假实现。
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

/** 映射目标的类别。 */
export type TargetKind =
  /** 关联到某个容器的已发布端口（可追踪容器生命周期）。 */
  | 'container'
  /** 关联到宿主机上的任意本机端口（例如 DSH、其它非容器服务）。 */
  | 'host';

/** 一条域名（路径）映射的目标。 */
export interface MappingTarget {
  kind: TargetKind;
  /** 宿主机侧端口；serve 会代理到 http://127.0.0.1:<hostPort>。 */
  hostPort: number;
  /** 追加到代理目标上的路径，"" 表示不追加。例如 "/api/agent"。 */
  targetPath: string;
  containerId?: string;
  containerName?: string;
  containerPort?: number;
}

/** 一条映射在 serve 配置中占用过的路由位置。 */
export interface OwnedRoute {
  /** 对外 HTTPS 端口。 */
  servePort: number;
  /** 挂载路径。 */
  path: string;
}

/** 指向 serve 中某个具体路由位置的引用（端口 + 路径）。 */
export type RouteRef = OwnedRoute;

/** TsController 持久化的映射记录。 */
export interface Mapping {
  id: string;
  /** 归一化后的挂载路径，始终以 "/" 开头且无尾斜杠（根路径例外）。 */
  path: string;
  /**
   * 该映射挂在哪个对外 HTTPS 端口上。
   *
   * 端口是路由身份的一半：`/` 在 443 与 8443 上是两个互不干扰的独立入口。
   * 这也是「独立 origin」得以成立的原因——不同端口就是不同 origin，
   * 根绝对路径的静态资源因此天然正确。
   */
  servePort: number;
  target: MappingTarget;
  note: string;
  enabled: boolean;
  /**
   * 该映射当前在 serve 配置中「占用」的位置集合。
   *
   * 存在的意义是路径或端口变更：变更后旧位置不再出现在 `path`/`servePort` 中，
   * 若不记账就会变成无人认领的孤儿 handler，继续把流量送进容器。
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
  | 'conflict';

/** 映射的运行时视图：持久化字段 + 实时状态。 */
export interface MappingView extends Mapping {
  status: MappingStatus;
  /** 期望写入 serve 的代理地址。 */
  desiredProxy: string;
  /** serve 配置中该路径当前实际指向的代理地址；未占用为 null。 */
  actualProxy: string | null;
  /** 面向用户的补充说明（例如目标容器已停止）。 */
  detail: string | null;
}

/** serve 配置中单个 handler 的解析结果。 */
export type ServeHandler =
  | {
      kind: 'proxy';
      /** 原始 Proxy 字符串。 */
      raw: string;
      /** 解析出的宿主机端口；无法解析为 http://127.0.0.1:port 时为 null。 */
      hostPort: number | null;
      /** 代理目标上追加的路径。 */
      targetPath: string;
      /** 是否指向本机回环地址。 */
      loopback: boolean;
    }
  | { kind: 'file' | 'text' | 'other'; raw: string };

/** serve 配置中的一条路由。 */
export interface ServeRoute {
  /** 这条 handler 所属的对外 HTTPS 端口。 */
  servePort: number;
  /** serve 主机名（不含端口）。 */
  host: string;
  path: string;
  handler: ServeHandler;
  /** 是否已被 TsController 接管（存在于映射库中）。 */
  managed: boolean;
  /** 被接管时对应的映射 id。 */
  mappingId: string | null;
}

/** `tailscale serve status --json` 的归一化快照。 */
export interface ServeSnapshot {
  /**
   * serve 中已声明的全部 HTTPS 端口，升序。
   *
   * 必须保留全部端口：早期实现只取与「默认端口」一致的那一组 `Web` 配置，
   * 导致挂在其它端口上的路由对 TsController 完全不可见——既管不了，
   * 安全闸门也扫不到。详见 `docs/static/function-index.md`。
   */
  httpsPorts: number[];
  /** serve 主机名（例如 `my-laptop.example-tailnet.ts.net`）；无 Web 配置时为 null。 */
  hostname: string | null;
  /** 全部端口上的路由，扁平存放，每条自带 `servePort`。 */
  routes: ServeRoute[];
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
