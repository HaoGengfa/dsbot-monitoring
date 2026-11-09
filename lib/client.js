/**
 * dsbot-monitoring client half：左侧导航「作战室」入口 + 主区域看板。
 *
 * 插槽契约（照 dsh-context 的实际用法，不要再猜）：
 *   · `sidebar.panellist` 是 sidebar 根插槽下的 list 子插槽，
 *     「插件 / 自动化任务 / 上下文洞察」那一列就是它渲染出来的。
 *     注册项要带 name='sidebar.panellist'、id、order、label、locale。
 *   · `main` 是主区域插槽，点击侧栏项后显示的内容挂在这里，用 key 与侧栏项对应。
 *
 * 之前错注册到 `sidebar`（那是容器根插槽，不接受条目），
 * 结果把 dsh-client-ui-sidebar 整个插件带崩（web boot: 1 entry did not activate）。
 *
 * 看板用 iframe 指向 Node half 提供的静态页，而不是重写成 React 组件：
 * stage.js（101KB）+ stage.css（154KB）已经按大屏布局调好，重写要连带重做
 * DOM 结构和样式作用域，收益为零。
 */

window.__ModuleLoader__.load({
  id: 'dsbot-monitoring',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');

    var NS = 'dsbot-monitoring';
    var STAGE_URL = '/bot-stage/stage.html';

    // 主区域：整块看板。
    //
    // 看板是按 1920×1080 大屏设计的密排布局，塞进 dsh 主面板（常见 1100~1600px）
    // 后硬改列宽只会把每块压成缝。这里换一个思路：iframe 内部**保持 1920 不变**，
    // 让页面按原始设计渲染（JS 读到的宽度也是 1920，SVG/拓扑/图表都算得对），
    // 再对 iframe 元素整体做 transform 缩放。
    // 比直接改 CSS 布局稳：视觉上就是原来那屏，只是等比小一点。
    var DESIGN_W = 1920;
    var DESIGN_H = 1120;

    function StagePanel() {
      var hostRef = react.useRef(null);
      var sizeState = react.useState(1);
      var scale = sizeState[0];
      var setScale = sizeState[1];

      react.useLayoutEffect(function () {
        var el = hostRef.current;
        if (!el) return undefined;
        function measure() {
          var w = el.clientWidth || DESIGN_W;
          setScale(w >= DESIGN_W ? 1 : w / DESIGN_W);
        }
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        var ro = new ResizeObserver(measure);
        ro.observe(el);
        return function () { ro.disconnect(); };
      }, []);

      return react.createElement(
        'div',
        { ref: hostRef, style: { width: '100%', height: '100%', overflow: 'auto' } },
        react.createElement(
          'div',
          {
            style: {
              // 外层按缩放后的实际尺寸占位，否则 transform 不影响布局会让滚动条算错
              width: DESIGN_W * scale,
              height: DESIGN_H * scale,
              overflow: 'hidden'
            }
          },
          react.createElement('iframe', {
            src: STAGE_URL,
            title: 'Bot 团队作战室',
            style: {
              width: DESIGN_W,
              height: DESIGN_H,
              border: '0',
              display: 'block',
              background: '#0a0f18',
              colorScheme: 'dark',
              transform: 'scale(' + scale + ')',
              transformOrigin: 'top left'
            }
          })
        )
      );
    }

    // 侧栏条目图标：label 只提供文字，图标由组件画。
    // 用一个「分栏看板」的轮廓，和「插件/上下文洞察」那排线条图标同一套观感：
    // 1.5px 描边、currentColor，自动跟随主题深浅。
    function SidebarEntry(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16;
      return react.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true'
        },
        react.createElement('rect', { x: 1.75, y: 2.75, width: 12.5, height: 10.5, rx: 2 }),
        react.createElement('path', { d: 'M1.75 6h12.5' }),
        react.createElement('path', { d: 'M6.25 6v7.25' })
      );
    }

    exports.inject = ['slots', 'locale'];

    exports.apply = function (ctx) {
      // 字典：label 走 t() 时要用
      ctx.effect(function () {
        return ctx.locale.register(NS, {
          zh: { 'panel.title': '作战室' },
          en: { 'panel.title': 'War room' }
        });
      }, 'dsbot-monitoring: locale');

      // 主区域
      ctx.effect(function () {
        return ctx.slots.inject('main', function () {
          return ctx.slots.register(
            { name: 'main', key: NS, locale: NS },
            StagePanel
          );
        });
      }, 'dsbot-monitoring: main panel');

      // 侧栏条目：order 30 让「上下文洞察」(order 20) 在前、它紧随其后
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: NS,
              order: 30,
              label: function () { return '作战室'; },
              locale: NS
            },
            SidebarEntry
          );
        });
      }, 'dsbot-monitoring: sidebar entry');
    };

    return module.exports;
  }
});
