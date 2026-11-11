# 小橘远程：原生客户端设计标准

首发 Android，桌面使用相同语义/协议、独立适配输入密度。NSH Rust 原生组件，应用拥有样式层；不把网页封装成客户端。

主要任务顺序是配置Relay、连接、配对、进入已授权的终端/Herdr/文件。未连接时聚焦一个Relay表单；连接后显示设备配对；已经配对时连接表单折叠为可编辑摘要。扫码与手输为同一配对行为，扫码不修改已经选定的Relay。主机指纹及批准状态必须可读。

字体使用平台系统字体，终端用系统monospace。字号12（辅助，不用于主状态）、14（正文/控件）、16（分组）、20（页面标题）。间距4/8/12/16/24，控件圆角8、sheet圆角16；避免把每行都变成卡片。手机控件最小48pt，桌面32pt。手机页面单一滚动容器，终端本身占满剩余区域；安全区和IME由页面适配。长设备名/地址可换行或截断后查看详情，不能挤掉状态/操作。

颜色全部取语义tokens。Light：background `#FFFFFF`，foreground `#242424`，card `#F6F6F6`，muted-foreground `#626262`，border `#D8D8D8`，primary `#934B13`，primary-foreground `#FFFFFF`；Dark：background `#171717`，foreground `#F3F3F3`，card `#232323`，muted-foreground `#B7B7B7`，border `#494949`，primary `#F3A55F`，primary-foreground `#241508`。危险/成功/警告/终端背景均有单独token，真实状态同时配文字，不能只靠红绿。颜色原值只出现在theme文件，页面/控件使用theme()。

共享styled controls包装NSH button/input/select/switch/alert/dialog，包含键盘焦点、按下、禁用、加载和错误状态。页面只组合控件。危险动作注明设备对象；“断开”允许再连接，“移除设备”永久撤销。只读状态使用文字标注，不仅禁用按钮。可操作授权不等于当前已取得终端控制，控制权必须单独可见。

终端/Herdr交互走同一终端渲染控件，原始输出按协议增量解码，保留颜色与ANSI；Herdr具有会话和pane列表，不退化成截图或纯文本聊天页。文件列表显示当前授权根目录、传输进度和校验/提交状态，不在用户界面暴露内部staging路径。

高频终端输入/输出/滚动无动效。低频配对sheet若自有平台组件已有系统过渡则沿用；网页设置仅使用现有motion token，transform/opacity 150—200ms，键盘触发即时、reduced motion弱化位置变化。无闪烁在线灯、装饰计数或阻碍读取的重排。

验证覆盖light/dark、360px/390px手机、较大字体、键盘/屏幕阅读器标签、焦点恢复、相机拒绝/取消、过期邀请、批准等待、断线、重连、只读、撤销及失败。headless验证行为，真实平台验证外观/IME/生命周期；两者分别记录。
