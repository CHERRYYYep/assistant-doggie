/** Synthetic N0–N3 samples. Keep the historical C0–C3 fixture independent. */
export const naturalLab = {
  version: "natural-conversation-v1",
  bucket: "计算机网络实验",
  tcp: {
    title: "TCP 实验",
    entry: "TCP 实验：客户端先发送 SYN，服务端回复 SYN-ACK。",
    draft: "客户端发送 SYN 报文后，服务端回复 SYN-ACK 报文。",
  },
  udp: {
    title: "UDP 实验",
    entry: "UDP 实验：发送 100 个数据报，收到 97 个，丢包率为 3%。",
  },
  original: "帮我修改那个计网实验",
  interlude: "SYN-ACK 是什么？",
  chooseTcp: "抓三次握手那个，报告把 SYN 和 SYN-ACK 顺序写反了，只改报告",
  directTcp: "把「TCP 实验」改成一句正式报告表述，不新增事实",
  tcpMaterial: "原文：客户端先发送 SYN，服务端回复 SYN-ACK。",
  tcpRequirement: "修改「TCP 抓包与三次握手」，只改报告，保留测量值",
  udpRequirement: "修改「UDP 丢包与重传观察」，只改报告，保留测量值",
  newRecord: "记一下：UDP 丢包率为 3%",
  assignmentConflict: ["不是 TCP", "两个都改"],
  nonApprovals: ["存下来", "好", "执行吧"],
} as const;
