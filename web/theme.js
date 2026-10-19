// 主题：light / dark（默认深色）。在 <head> 同步执行，避免页面闪一下
(() => {
	const t = localStorage.getItem("ci.theme");
	document.documentElement.dataset.theme = t === "light" ? "light" : "dark";
})();
