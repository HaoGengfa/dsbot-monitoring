/**
 * dsbot-monitoring client half：左侧导航里的「作战室」入口。
 *
 * 为什么用 iframe 而不是把看板重写成 React 组件：
 * 看板前端是 stage.js（101KB）+ stage.css（154KB）的独立页面，已经按大屏布局
 * 调好了（拓扑带、思考卡、日志流、统计条）。硬塞进 React 组件树要重写全部
 * DOM 结构和样式作用域，收益为零。iframe 指向同一插件的静态路由，
 * 既能保持原有布局，又不会和 DSH 自己的样式互相污染。
 *
 * 模块格式照官方 client 插件：
 *   window.__ModuleLoader__.load({ id, factory: (require) => {...} })
 *   factory 返回 { name?, apply(ctx), inject? }，client 内核挂载时调 apply(ctx)。
 */

window.__ModuleLoader__.load({
  id: 'dsbot-monitoring',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');

    // Node half 注册的静态路由前缀（见 index.mjs 的 MOUNT）
    var STAGE_URL = '/bot-stage/stage.html';

    function StageFrame() {
      // 高度用绝对定位铺满：sidebar 插槽给的容器不保证有确定高度，
      // 直接 height:100% 在部分布局下会塌成 0。
      return react.createElement(
        'div',
        { style: { position: 'relative', width: '100%', height: '100%', minHeight: '520px' } },
        react.createElement('iframe', {
          src: STAGE_URL,
          title: 'Bot 团队作战室',
          style: {
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
            border: '0',
            display: 'block',
            background: '#0a0f18',
            colorScheme: 'dark'
          }
        })
      );
    }

    exports.inject = ['slots'];

    exports.apply = function (ctx) {
      ctx.effect(function () {
        return ctx.slots.inject('sidebar', function () {
          return ctx.slots.register(
            {
              name: 'sidebar',
              id: 'dsbot-monitoring',
              // order 越大越靠下。「上下文洞察」是 20，这里排在它后面。
              order: 30,
              label: '作战室'
            },
            StageFrame
          );
        });
      }, 'dsbot-monitoring: sidebar entry');
    };

    return module.exports;
  }
});
