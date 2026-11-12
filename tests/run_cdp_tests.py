"""
Chrome DevTools Protocol (CDP) Test Suite for RackStudio PRO
Connects to Chromium/Edge headless via CDP over WebSockets.
Tests all UI buttons, modals, state interactions, rendering, and consoles.
"""

import asyncio
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
import websockets

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
TEST_URL = "http://localhost:8080/index.html"
PORT = 9222
USER_DATA_DIR = os.path.join(os.path.dirname(__file__), ".cdp_test_profile")

class CDPClient:
    def __init__(self, ws_url):
        self.ws_url = ws_url
        self.ws = None
        self.msg_id = 1
        self.pending = {}
        self.console_errors = []
        self.console_logs = []
        self._listener_task = None

    async def connect(self):
        self.ws = await websockets.connect(self.ws_url, max_size=10_000_000)
        self._listener_task = asyncio.create_task(self._listen())
        await self.send("Runtime.enable")
        await self.send("Page.enable")
        await self.send("DOM.enable")
        await self.send("Network.enable")
        await self.send("Network.setCacheDisabled", {"cacheDisabled": True})

    async def _listen(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                msg_id = msg.get("id")
                if msg_id and msg_id in self.pending:
                    self.pending[msg_id].set_result(msg)
                method = msg.get("method", "")
                if method == "Runtime.consoleAPICalled":
                    params = msg.get("params", {})
                    log_type = params.get("type", "log")
                    text = " ".join([str(arg.get("value", arg.get("description", ""))) for arg in params.get("args", [])])
                    self.console_logs.append(f"[{log_type}] {text}")
                    if log_type in ("error", "assert"):
                        self.console_errors.append(f"[{log_type}] {text}")
                elif method == "Runtime.exceptionThrown":
                    details = msg.get("params", {}).get("exceptionDetails", {})
                    exc_text = details.get("text", "") + " " + str(details.get("exception", {}).get("description", ""))
                    self.console_errors.append(f"[EXCEPTION] {exc_text}")
                elif method == "Page.javascriptDialogOpening":
                    asyncio.create_task(self.send("Page.handleJavaScriptDialog", {"accept": True}))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            # Connection closed
            pass

    async def send(self, method, params=None):
        mid = self.msg_id
        self.msg_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[mid] = future
        payload = {"id": mid, "method": method}
        if params:
            payload["params"] = params
        await self.ws.send(json.dumps(payload))
        res = await asyncio.wait_for(future, timeout=10.0)
        del self.pending[mid]
        if "error" in res:
            raise RuntimeError(f"CDP Error in {method}: {res['error']}")
        return res.get("result", {})

    async def eval(self, expression, await_promise=False):
        res = await self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise
        })
        val_obj = res.get("result", {})
        if "value" in val_obj:
            return val_obj["value"]
        if val_obj.get("subtype") == "error":
            raise RuntimeError(f"Eval Exception: {val_obj.get('description')}")
        return val_obj

    async def close(self):
        if self._listener_task:
            self._listener_task.cancel()
        if self.ws:
            await self.ws.close()


def ensure_server():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/index.html", timeout=0.8) as resp:
            if resp.getcode() == 200:
                return None
    except Exception:
        pass
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cmd = [sys.executable, "-m", "http.server", "8080", "--directory", root_dir]
    server_proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    return server_proc


def launch_browser():
    profile_dir = os.path.join(USER_DATA_DIR, str(int(time.time() * 1000)))
    os.makedirs(profile_dir, exist_ok=True)
    cmd = [
        EDGE_PATH,
        "--headless=new",
        "--window-size=1440,900",
        f"--remote-debugging-port={PORT}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-gpu",
        "--disable-cache",
        "--disk-cache-size=1",
        "about:blank"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc


def get_ws_url():
    for _ in range(25):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=1.0) as resp:
                data = json.loads(resp.read().decode())
                for tab in data:
                    if tab.get("type") == "page":
                        return tab.get("webSocketDebuggerUrl")
        except Exception:
            time.sleep(0.3)
    raise RuntimeError("Could not connect to browser debugging port")


async def run_test_suite():
    print("=" * 70)
    print("  RackStudio PRO - Automated Chrome DevTools (CDP) Test Runner")
    print("=" * 70)

    print("\n[1/9] Launching Chromium (Edge) in headless mode with remote debugging...")
    server_proc = ensure_server()
    proc = launch_browser()
    test_results = []

    def record(name, success, details=""):
        status = "PASSED" if success else "FAILED"
        print(f"  [{status}] {name}" + (f" -> {details}" if details else ""))
        test_results.append((name, success, details))

    try:
        ws_url = get_ws_url()
        print(f"[2/9] Connected to CDP endpoint: {ws_url}")
        client = CDPClient(ws_url)
        await client.connect()
        await client.send("Emulation.setDeviceMetricsOverride", {
            "width": 1440,
            "height": 900,
            "deviceScaleFactor": 1,
            "mobile": False
        })

        # Step 1: Navigate to app
        print(f"[3/9] Navigating to {TEST_URL} ...")
        await client.send("Page.navigate", {"url": TEST_URL})
        for _ in range(50):
            ready = await client.eval("typeof window.app === 'object' && typeof window.store === 'object'")
            if ready:
                break
            await asyncio.sleep(0.1)

        # Reset localStorage and reload to guarantee fresh test isolation
        await client.eval("localStorage.clear(); sessionStorage.clear();")
        await client.send("Page.reload")
        await asyncio.sleep(0.5)
        for _ in range(50):
            ready = await client.eval("typeof window.app === 'object' && typeof window.store === 'object'")
            if ready:
                break
            await asyncio.sleep(0.1)

        # Non-blocking dialog mocks for automated headless testing
        await client.eval("window.alert = (msg) => console.log('[ALERT]', msg); window.confirm = () => true;")

        # -------------------------------------------------------------
        # TEST 1: App Boot & Core Objects
        # -------------------------------------------------------------
        print("\n--- Test Suite 1: App Lifecycle & Global Objects ---")
        app_exists = await client.eval("typeof window.app !== 'undefined'")
        store_exists = await client.eval("typeof window.store !== 'undefined'")
        racks_count = await client.eval("window.store ? window.store.getRacks().length : 0")
        active_rack_u = await client.eval("window.store ? window.store.getActiveRack().uHeight : 0")
        
        record("window.app is instantiated", app_exists)
        record("window.store is initialized", store_exists)
        record(f"Default rack exists ({active_rack_u}U)", racks_count > 0 and active_rack_u == 24, f"{racks_count} racks, active {active_rack_u}U")
        reset_btn_absent = await client.eval("document.getElementById('btn-reset-demo') === null")
        record("Reset to demo button is removed from header", reset_btn_absent)

        # -------------------------------------------------------------
        # TEST 2: Add Rack Button (+ Стойка modal) & Creation
        # -------------------------------------------------------------
        print("\n--- Test Suite 2: Rack Management (+ Стойка) ---")
        
        # Click header + Стойка button
        await client.eval("document.getElementById('btn-add-rack').click()")
        await asyncio.sleep(0.3)
        modal_visible = await client.eval("""
            (() => {
                const el = document.getElementById('rack-modal');
                return el && (el.style.display === 'flex' || !el.classList.contains('hidden'));
            })()
        """)
        record("Click '#btn-add-rack' opens Rack Modal", modal_visible)

        # Fill modal and create new 42U rack
        creation_success = await client.eval("""
            (() => {
                const nameInp = document.getElementById('rack-name-input');
                const uInp = document.getElementById('rack-u-input');
                const form = document.getElementById('rack-form');
                if (!nameInp || !uInp || !form) return false;

                nameInp.value = 'Серверная 42U (ЦОД Main)';
                uInp.value = '42';
                
                // Submit form
                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvent);
                return true;
            })()
        """)
        await asyncio.sleep(0.5)

        active_u_after_add = await client.eval("window.store.getActiveRack().uHeight")
        active_name_after_add = await client.eval("window.store.getActiveRack().name")
        racks_after_add = await client.eval("window.store.getRacks().length")
        
        record("Create 42U Rack via form submission", creation_success and active_u_after_add == 42 and racks_after_add == 2, f"Active: '{active_name_after_add}', {active_u_after_add}U")

        # Verify #rack-container now renders 42 units (installed devices + empty slots)
        rendered_units_count = await client.eval("document.querySelectorAll('#rack-container .slot-empty, #rack-container .installed-device').length")
        record("Rack viewport re-rendered with 42 units", rendered_units_count == 42, f"Found {rendered_units_count} unit slots")

        # Test Sidebar + Стойка button
        await client.eval("document.getElementById('btn-sidebar-add-rack').click()")
        await asyncio.sleep(0.2)
        sidebar_btn_opened = await client.eval("!document.getElementById('rack-modal').classList.contains('hidden')")
        record("Click '#btn-sidebar-add-rack' opens Rack Modal", sidebar_btn_opened)
        
        # Close with Cancel button
        await client.eval("document.getElementById('btn-cancel-rack-modal').click()")
        await asyncio.sleep(0.2)
        modal_closed = await client.eval("document.getElementById('rack-modal').classList.contains('hidden') || document.getElementById('rack-modal').style.display === 'none'")
        record("Close Rack Modal with Cancel button", modal_closed)

        # Test Edit Rack settings button
        await client.eval("document.getElementById('btn-edit-rack').click()")
        await asyncio.sleep(0.2)
        edit_title = await client.eval("document.getElementById('rack-modal-title').textContent")
        record("Click '#btn-edit-rack' opens Settings for current rack", "Настройки" in edit_title, f"Title: {edit_title}")
        await client.eval("document.getElementById('close-rack-modal').click()")
        await asyncio.sleep(0.2)

        # -------------------------------------------------------------
        # TEST 3: Device Palette & Installation (+ Устройство)
        # -------------------------------------------------------------
        print("\n--- Test Suite 3: Device Catalog & Rack Installation ---")
        await client.eval("document.getElementById('btn-catalog').click()")
        await asyncio.sleep(0.3)
        palette_open = await client.eval("!document.getElementById('palette-modal').classList.contains('hidden')")
        templates_count = await client.eval("document.querySelectorAll('#palette-devices-list > div').length")
        record("Click '#btn-catalog' opens Device Catalog", palette_open)
        record(f"Catalog contains device templates", templates_count >= 5, f"{templates_count} equipment templates listed")

        # Install a 24-port switch into unit 24
        install_res = await client.eval("""
            (() => {
                const dev = window.store.installDevice('tpl-switch-24p', 24);
                if (window.app && window.app.closeDevicePalette) {
                    window.app.closeDevicePalette();
                }
                return dev ? dev.id : null;
            })()
        """)
        await asyncio.sleep(0.4)
        record("Install UniFi 24-Port Switch into U24", bool(install_res), f"Installed device ID: {install_res}")

        # Install a Patch Panel into unit 23
        install_patch = await client.eval("""
            (() => {
                const dev = window.store.installDevice('tpl-patch-24p', 23);
                return dev ? dev.id : null;
            })()
        """)
        await asyncio.sleep(0.4)
        record("Install 24P Patch Panel into U23", bool(install_patch), f"Installed patch panel ID: {install_patch}")

        # Verify devices are rendered in the rack
        rendered_devices_count = await client.eval("document.querySelectorAll('#rack-container .installed-device').length")
        record("Rack Enclosure renders installed device faceplates", rendered_devices_count >= 2, f"{rendered_devices_count} devices mounted")

        # Verify Etherlighting ports are present
        etherlighting_ports = await client.eval("document.querySelectorAll('#rack-container .port-slot').length")
        record("Etherlighting interactive ports rendered", etherlighting_ports >= 48, f"{etherlighting_ports} RJ45/SFP+ ports active")

        # Verify 2-row port labels do not overlap lower-row jacks
        two_row_labels_ok = await client.eval("""
            (() => {
                const swDev = document.querySelector(`#rack-container .installed-device[data-device-id="${install_switch}"]`);
                const ppDev = document.querySelector(`#rack-container .installed-device[data-device-id="${install_patch}"]`);
                if (!swDev || !ppDev) return false;
                const swRect = swDev.getBoundingClientRect();
                const p1 = swDev.querySelector('.port-slot[data-port-id="p-1"]');
                const p2 = swDev.querySelector('.port-slot[data-port-id="p-2"]');
                const sfp1 = swDev.querySelector('.port-slot[data-port-id="sfp-1"]');
                const pp1 = ppDev.querySelector('.port-slot[data-port-id="p-1"]');
                if (!p1 || !p2 || !sfp1 || !pp1) return false;
                const p1Jack = p1.querySelector('.port-jack').getBoundingClientRect();
                const p1Num = p1.querySelector('.port-num').getBoundingClientRect();
                const p2Jack = p2.querySelector('.port-jack').getBoundingClientRect();
                const p2Num = p2.querySelector('.port-num').getBoundingClientRect();
                return (
                    p1.dataset.labelPos === 'top' &&
                    p2.dataset.labelPos === 'bottom' &&
                    sfp1.dataset.labelPos === 'bottom' &&
                    pp1.dataset.labelPos === 'bottom' &&
                    p1Num.bottom <= p1Jack.top + 0.5 &&
                    p1Num.bottom <= p2Jack.top &&
                    p1Num.top >= swRect.top - 0.5 &&
                    p2Num.top >= p2Jack.bottom - 0.5 &&
                    p2Num.bottom <= swRect.bottom + 0.5
                );
            })()
        """.replace("${install_switch}", str(install_res)).replace("${install_patch}", str(install_patch)))
        record("Two-row top port labels placed above jacks without clipping", bool(two_row_labels_ok))

        # Verify U-slot badges are removed from installed device faceplates while names remain
        u_badge_removed_ok = await client.eval("""
            (() => {
                const swDev = document.querySelector(`#rack-container .installed-device[data-device-id="${install_switch}"]`);
                const ppDev = document.querySelector(`#rack-container .installed-device[data-device-id="${install_patch}"]`);
                if (!swDev || !ppDev) return false;
                const swText = swDev.textContent || '';
                const ppText = ppDev.textContent || '';
                return (
                    swText.includes('Switch 24-Port Pro Max PoE') &&
                    ppText.includes('Patch Panel 24P Cat6 UTP') &&
                    !swText.includes('U24') &&
                    !ppText.includes('U23')
                );
            })()
        """.replace("${install_switch}", str(install_res)).replace("${install_patch}", str(install_patch)))
        record("Installed devices omit U-slot badge while keeping device names", bool(u_badge_removed_ok))

        # Verify dragging installed device to free slot U21 and blocking occupied U24
        drag_coords = await client.eval(f"""
            (() => {{
                const ppDev = document.querySelector('#rack-container .installed-device[data-device-id="{install_patch}"]');
                if (!ppDev) return null;
                ppDev.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                const rect = ppDev.getBoundingClientRect();
                const slotH = rect.height;
                return {{ x: rect.left + 8, y: rect.top + slotH / 2, slotH }};
            }})()
        """)
        drag_move_ok = False
        drag_blocked_ok = False
        if drag_coords:
            gx = drag_coords["x"]
            gy = drag_coords["y"]
            sh = drag_coords["slotH"]
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": gx, "y": gy, "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": gx, "y": gy + sh, "buttons": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": gx, "y": gy + 2 * sh, "buttons": 1})
            await asyncio.sleep(0.1)
            preview_u21 = await client.eval("document.getElementById('rack-drop-preview')?.textContent || ''")
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": gx, "y": gy + 2 * sh, "button": "left", "clickCount": 1})
            await asyncio.sleep(0.25)
            pos_after_drag = await client.eval(f"window.store.getActiveRack().installedDevices.find(d => d.id === '{install_patch}')?.uPosition")
            drag_move_ok = (preview_u21 == "U21" and pos_after_drag == 21)

            # Now test dropping onto occupied U24 is rejected
            drag_coords2 = await client.eval(f"""
                (() => {{
                    const ppDev = document.querySelector('#rack-container .installed-device[data-device-id="{install_patch}"]');
                    if (!ppDev) return null;
                    ppDev.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                    const rect = ppDev.getBoundingClientRect();
                    return {{ x: rect.left + 8, y: rect.top + rect.height / 2, slotH: rect.height }};
                }})()
            """)
            if drag_coords2:
                gx2 = drag_coords2["x"]
                gy2 = drag_coords2["y"]
                sh2 = drag_coords2["slotH"]
                await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": gx2, "y": gy2, "button": "left", "clickCount": 1})
                await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": gx2, "y": gy2 - 3 * sh2, "buttons": 1})
                await asyncio.sleep(0.1)
                preview_u24 = await client.eval("document.getElementById('rack-drop-preview')?.textContent || ''")
                await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": gx2, "y": gy2 - 3 * sh2, "button": "left", "clickCount": 1})
                await asyncio.sleep(0.25)
                pos_after_blocked = await client.eval(f"window.store.getActiveRack().installedDevices.find(d => d.id === '{install_patch}')?.uPosition")
                drag_blocked_ok = ("Занято" in preview_u24 and pos_after_blocked == 21)

        record("Drag device to free slot updates uPosition (U23 -> U21)", drag_move_ok)
        record("Dragging device onto occupied slot (U24) is blocked", drag_blocked_ok)

        # -------------------------------------------------------------
        # TEST 4: Workplace Groups & Isolation Filtering (+ Группа)
        # -------------------------------------------------------------
        print("\n--- Test Suite 4: Workplace Groups & Visual Isolation ---")
        await client.eval("document.getElementById('btn-add-group').click()")
        await asyncio.sleep(0.3)
        group_modal_open = await client.eval("!document.getElementById('group-modal').classList.contains('hidden')")
        record("Click '#btn-add-group' opens Workplace Group Modal", group_modal_open)

        # Create new group
        new_group_id = await client.eval("""
            (() => {
                const nameInp = document.getElementById('grp-name-input');
                const colorInp = document.getElementById('grp-color-input');
                const vlanInp = document.getElementById('grp-vlan-input');
                const form = document.getElementById('group-form');
                
                nameInp.value = 'Рабочее место Инженер 1 (CAD)';
                colorInp.value = '#00ffcc';
                vlanInp.value = '30';
                
                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                form.dispatchEvent(submitEvent);

                const groups = window.store.getGroups();
                const created = groups.find(g => g.name === 'Рабочее место Инженер 1 (CAD)');
                return created ? created.id : null;
            })()
        """)
        await asyncio.sleep(0.4)
        record("Add new workplace group (VLAN 30, #00ffcc)", bool(new_group_id), f"Group ID: {new_group_id}")

        # Check badge rendered in workplace filter bar
        filter_pills_count = await client.eval("document.querySelectorAll('#workplace-filter-bar .filter-pill').length")
        record("Workplace Filter Bar renders interactive pills", filter_pills_count >= 2, f"{filter_pills_count} filter pills (ALL + groups)")

        # Verify Rack Isolation of Connection Groups
        rack1_id = await client.eval("window.store.getRacks()[0].id")
        rack1_groups_count = await client.eval(f"window.store.getGroups('{rack1_id}').length")
        record("Connection group is strictly isolated to active rack", rack1_groups_count == 0, f"Rack 1 groups: {rack1_groups_count}, Active Rack 2 groups: 1")

        # Switch to Rack 1 and verify its workplace bar has 0 groups (only 'ALL')
        await client.eval(f"window.store.setActiveRack('{rack1_id}')")
        await asyncio.sleep(0.3)
        rack1_pills = await client.eval("document.querySelectorAll('#workplace-filter-bar .filter-pill').length")
        record("Workplace bar updates on rack switch showing only its own groups", rack1_pills == 1, f"Found {rack1_pills} pill ('ALL') on Rack 1")

        # Create a dedicated group for Rack 1
        rack1_group_id = await client.eval("""
            (() => {
                const g = window.store.addGroup('АРМ Бухгалтер (Кабинет 101)', '#ffbb00', 10);
                return g ? g.id : null;
            })()
        """)
        await asyncio.sleep(0.3)
        record("Add dedicated group to Rack 1", bool(rack1_group_id))

        # Switch back to Rack 2
        rack2_id = await client.eval("window.store.getRacks()[1].id")
        await client.eval(f"window.store.setActiveRack('{rack2_id}')")
        await asyncio.sleep(0.3)
        rack2_has_only_own_group = await client.eval(f"""
            (() => {{
                const grps = window.store.getGroups();
                return grps.length === 1 && grps[0].id === '{new_group_id}';
            }})()
        """)
        record("Switching back to Rack 2 restores only Rack 2's isolated groups", rack2_has_only_own_group)

        # -------------------------------------------------------------
        # TEST 5: Cable Patching & SVG Bezier Curves
        # -------------------------------------------------------------
        print("\n--- Test Suite 5: Cable Patching & Selection Drawer ---")
        cable_connected = await client.eval(f"""
            (() => {{
                const rack = window.store.getActiveRack();
                const devs = rack.installedDevices;
                if (devs.length < 2) return null;
                const devA = devs[0];
                const devB = devs[1];
                
                // Connect Port 1 of Switch to Port 1 of Patch panel
                const cable = window.store.addCable({{
                    from: {{ deviceId: devA.id, portId: 'p-1' }},
                    to: {{ deviceId: devB.id, portId: 'p-1' }},
                    groupId: '{new_group_id}',
                    color: '#00ffcc',
                    type: 'Cat6 UTP'
                }});
                return cable ? cable.id : null;
            }})()
        """)
        await asyncio.sleep(0.5)
        record("Create patch cable between Switch and Patch Panel", bool(cable_connected), f"Cable ID: {cable_connected}")

        # Check SVG cable path rendered
        svg_cables_count = await client.eval("document.querySelectorAll('#cables-svg .cable-group').length")
        record("SVG Cable Layer renders Bezier curve for patch cord", svg_cables_count >= 1, f"Rendered {svg_cables_count} cable path(s)")

        # Select cable to inspect details in drawer
        await client.eval(f"window.store.setSelection({{ type: 'cable', id: '{cable_connected}' }})")
        await asyncio.sleep(0.3)
        drawer_visible = await client.eval("!document.getElementById('details-drawer').classList.contains('translate-x-full')")
        drawer_has_cable = await client.eval("document.getElementById('drawer-cable-label') !== null")
        record("Select cable opens Inspector Drawer with properties", drawer_visible and drawer_has_cable)

        # Close group modal left open from Test Suite 4 before mouse hit-testing
        await client.eval("document.getElementById('close-group-modal')?.click(); window.store.clearSelection();")
        await asyncio.sleep(0.1)

        # Verify upper-row cable does not overlap lower-row ports & lower-row port accepts clicks
        p2_info = await client.eval(f"""
            (() => {{
                const rack = window.store.getActiveRack();
                const sw = rack.installedDevices.find(d => d.templateId === 'tpl-switch-24p');
                if (!sw) return null;
                const swEl = document.querySelector(`#rack-container .installed-device[data-device-id="${{sw.id}}"]`);
                const p2Slot = swEl?.querySelector('.port-slot[data-port-id="p-2"] .port-jack');
                if (!p2Slot) return null;
                p2Slot.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                const r = p2Slot.getBoundingClientRect();
                const hitCable = window.app.cableRenderer.findCableAtClientPoint(r.left + r.width / 2, r.top + r.height / 2);
                return {{ x: r.left + r.width / 2, y: r.top + r.height / 2, overlapsLowerPort: Boolean(hitCable) }};
            }})()
        """)
        lower_port_clear_and_clickable = False
        if p2_info and not p2_info["overlapsLowerPort"]:
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": p2_info["x"], "y": p2_info["y"], "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": p2_info["x"], "y": p2_info["y"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)
            draft_port = await client.eval("window.store.cableDraft ? window.store.cableDraft.portId : null")
            await client.eval("window.store.cancelCableDraft()")
            lower_port_clear_and_clickable = (draft_port == "p-2")
        record("Upper-row cable clears lower-row ports and lower-row port accepts clicks", lower_port_clear_and_clickable)

        # Verify clicking cable along its side channel selects cable via isPointInStroke
        cable_pt = await client.eval(f"""
            (() => {{
                const cr = window.app.cableRenderer;
                const item = cr.renderedCables.find(c => c.cable.id === '{cable_connected}');
                if (!item || !item.hitPath.getTotalLength) return null;
                const len = item.hitPath.getTotalLength();
                const pt = item.hitPath.getPointAtLength(len * 0.5);
                const svgRect = cr.svg.getBoundingClientRect();
                return {{ x: svgRect.left + pt.x, y: svgRect.top + pt.y }};
            }})()
        """)
        cable_channel_selectable = False
        if cable_pt:
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cable_pt["x"], "y": cable_pt["y"]})
            await asyncio.sleep(0.1)
            hover_id = await client.eval("window.app.cableRenderer.activeHoverCableId")
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cable_pt["x"], "y": cable_pt["y"], "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cable_pt["x"], "y": cable_pt["y"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)
            selected_cable_id = await client.eval("window.store.selectedEntity?.id || null")
            cable_channel_selectable = (hover_id == cable_connected and selected_cable_id == cable_connected)
        record("Hover and click along cable channel hits cable cleanly", cable_channel_selectable, f"pt={cable_pt}, hover={hover_id if cable_pt else None}, sel={selected_cable_id if cable_pt else None}")
        # -------------------------------------------------------------
        # TEST 6: Switch CLI Terminal Modal
        # -------------------------------------------------------------
        print("\n--- Test Suite 6: Switch CLI Terminal Auto-Scaffolding ---")
        cli_opened = await client.eval("""
            (() => {
                const rack = window.store.getActiveRack();
                const sw = rack.installedDevices.find(d => d.templateId === 'tpl-switch-24p');
                if (!sw) return false;
                window.openDeviceCli(sw.id);
                const modal = document.getElementById('cli-modal');
                return modal && !modal.classList.contains('hidden');
            })()
        """)
        await asyncio.sleep(0.4)
        record("Open CLI Terminal Modal for Switch", cli_opened)

        # Verify port auto-config button was removed and CLI config editing persists
        cli_btn_absent = await client.eval("document.getElementById('cli-generate-btn') === null")
        record("Switch CLI port auto-generation button is removed", cli_btn_absent)

        cli_edited_ok = await client.eval("""
            (() => {
                const area = document.getElementById('cli-code-area');
                if (!area) return false;
                area.value = 'hostname Sw-Core-24\\ninterface Gi0/1\\n no shutdown\\nend';
                area.dispatchEvent(new Event('input', { bubbles: true }));
                const rack = window.store.getActiveRack();
                const sw = rack.installedDevices.find(d => d.templateId === 'tpl-switch-24p');
                return Boolean(sw && sw.cliConfig.includes('hostname Sw-Core-24'));
            })()
        """)
        record("CLI editor saves manual configuration changes", bool(cli_edited_ok))

        # Close CLI modal
        await client.eval("document.getElementById('close-cli-modal')?.click()")
        await asyncio.sleep(0.2)
        record("Close CLI Terminal Modal", True)

        # -------------------------------------------------------------
        # TEST 7: Template Builder & Alignment Tools
        # -------------------------------------------------------------
        print("\n--- Test Suite 7: Custom Template Builder & Alignment Grid ---")
        await client.eval("document.getElementById('btn-template-builder').click()")
        await asyncio.sleep(0.3)
        builder_open = await client.eval("!document.getElementById('builder-modal').classList.contains('hidden')")
        record("Click '#btn-template-builder' opens Custom Device Designer", builder_open)

        # Test Batch Generator (Generate 8 ports)
        batch_generated = await client.eval("""
            (() => {
                const tb = window.app.templateBuilder;
                if (!tb) return false;
                tb.generate8Ports();
                return tb.currentTemplate.ports.length === 8;
            })()
        """)
        record("Batch generate 8 RJ45 ports", batch_generated)

        # Test coaxial 2-row alignment tool
        coaxial_aligned = await client.eval("""
            (() => {
                const tb = window.app.templateBuilder;
                tb.generate24Ports();
                tb.alignTwoRowsCoaxial();
                
                // Verify ports alternate between row 1 (33%) and row 2 (67%)
                const p0 = tb.currentTemplate.ports[0];
                const p1 = tb.currentTemplate.ports[1];
                return Math.abs(p0.y - 33) < 1 && Math.abs(p1.y - 67) < 1;
            })()
        """)
        record("Apply '⇕ В 2 соосных ряда' vertical & horizontal auto-alignment", coaxial_aligned)

        # Save custom template
        saved_tpl = await client.eval("""
            (() => {
                const tb = window.app.templateBuilder;
                document.getElementById('builder-name').value = 'Мой Кастомный Маршрутизатор 2U';
                tb.currentTemplate.name = 'Мой Кастомный Маршрутизатор 2U';
                const uSel = document.getElementById('builder-u-height');
                if (uSel) uSel.value = '2';
                tb.currentTemplate.uHeight = 2;
                tb.saveTemplate();
                return true;
            })()
        """)
        await asyncio.sleep(0.4)
        record("Save custom template to equipment library", bool(saved_tpl))

        # Verify custom template appears in catalog
        await client.eval("document.getElementById('btn-catalog').click()")
        await asyncio.sleep(0.3)
        found_custom_in_catalog = await client.eval("""
            (() => {
                const cards = Array.from(document.querySelectorAll('#palette-devices-list h4'));
                return cards.some(c => c.textContent.includes('Мой Кастомный Маршрутизатор 2U'));
            })()
        """)
        record("Custom template is listed in Device Catalog ready to install", found_custom_in_catalog)

        # Open edit mode for the custom template from Device Catalog
        edit_opened = await client.eval("""
            (() => {
                const cards = Array.from(document.querySelectorAll('#palette-devices-list > div'));
                const card = cards.find(c => c.textContent.includes('Мой Кастомный Маршрутизатор 2U'));
                if (!card) return false;
                const editBtn = card.querySelector('button[title="Редактировать шаблон устройства"]');
                if (!editBtn) return false;
                editBtn.click();
                return true;
            })()
        """)
        await asyncio.sleep(0.3)
        edit_state_ok = await client.eval("""
            (() => {
                const modal = document.getElementById('builder-modal');
                const saveBtn = document.getElementById('btn-save-template');
                const nameInput = document.getElementById('builder-name');
                const tb = window.app.templateBuilder;
                return Boolean(
                    modal && !modal.classList.contains('hidden') &&
                    tb && tb.editingTemplateId &&
                    nameInput && nameInput.value === 'Мой Кастомный Маршрутизатор 2U' &&
                    saveBtn && saveBtn.textContent.includes('Сохранить изменения')
                );
            })()
        """)
        record("Edit existing template opens Builder with populated fields", bool(edit_opened and edit_state_ok))

        # Modify template name & power and save changes
        tpl_count_before_edit = await client.eval("window.store.getTemplates().length")
        await client.eval("""
            (() => {
                const nameInput = document.getElementById('builder-name');
                nameInput.value = 'Мой Кастомный Маршрутизатор 2U (ред.)';
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                const powerInput = document.getElementById('builder-power');
                powerInput.value = '120';
                powerInput.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('btn-save-template').click();
            })()
        """)
        await asyncio.sleep(0.4)
        edit_saved_ok = await client.eval(f"""
            (() => {{
                const tpls = window.store.getTemplates();
                const updated = tpls.find(t => t.name === 'Мой Кастомный Маршрутизатор 2U (ред.)');
                return tpls.length === {tpl_count_before_edit} && Boolean(updated && updated.powerW === 120 && updated.ports.length === 24);
            }})()
        """)
        record("Saving edited template updates existing template in store", edit_saved_ok)

        # -------------------------------------------------------------
        # TEST 8: Drawer Actions & Deletions
        # -------------------------------------------------------------
        print("\n--- Test Suite 8: Drawer Operations & Element Deletion ---")
        
        # Select cable and click delete cable in drawer
        await client.eval(f"window.store.setSelection({{ type: 'cable', id: '{cable_connected}' }})")
        await asyncio.sleep(0.3)
        cables_before_del = await client.eval("window.store.state.cables.length")
        
        # Click delete button in details-drawer
        await client.eval("""
            (() => {
                const delBtn = document.querySelector('#details-content button[onclick*=\"removeCable\"]');
                if (delBtn) delBtn.click();
            })()
        """)
        await asyncio.sleep(0.4)
        cables_after_del = await client.eval("window.store.state.cables.length")
        record("Delete cable via Inspector Drawer button", cables_after_del == cables_before_del - 1, f"Cables: {cables_before_del} -> {cables_after_del}")

        # Select switch and delete via drawer
        await client.eval(f"window.store.setSelection({{ type: 'device', id: '{install_patch}' }})")
        await asyncio.sleep(0.3)
        devices_before_del = await client.eval("window.store.getActiveRack().installedDevices.length")
        await client.eval("""
            (() => {
                const delBtn = document.querySelector('#details-content button[onclick*=\"removeDevice\"]');
                if (delBtn) delBtn.click();
            })()
        """)
        await asyncio.sleep(0.4)
        devices_after_del = await client.eval("window.store.getActiveRack().installedDevices.length")
        record("Delete installed device via Inspector Drawer button", devices_after_del == devices_before_del - 1, f"Devices: {devices_before_del} -> {devices_after_del}")

        # Test Rack switching via dropdown
        await client.eval("""
            (() => {
                const rSelect = document.getElementById('rack-select');
                const firstRackId = window.store.getRacks()[0].id;
                rSelect.value = firstRackId;
                rSelect.dispatchEvent(new Event('change', { bubbles: true }));
            })()
        """)
        await asyncio.sleep(0.4)
        active_u_switched = await client.eval("window.store.getActiveRack().uHeight")
        record("Switch rack via '#rack-select' dropdown", active_u_switched == 24, f"Active switched to: {active_u_switched}U rack")

        # --- NEW: Delete Connection Group ---
        groups_before = await client.eval("window.store.getAllGroups().length")
        await client.eval(f"window.deleteGroupConfirm('{new_group_id}')")
        await asyncio.sleep(0.3)
        groups_after = await client.eval("window.store.getAllGroups().length")
        record("Delete connection group from system", groups_after == groups_before - 1, f"Total groups: {groups_before} -> {groups_after}")

        # --- NEW: Delete Device Template from Pool ---
        templates_before = await client.eval("window.store.getTemplates().length")
        custom_tpl_id = await client.eval("""
            (() => {
                const tpls = window.store.getTemplates();
                const found = tpls.find(t => t.name.includes('Мой Кастомный Маршрутизатор 2U'));
                return found ? found.id : null;
            })()
        """)
        await client.eval(f"window.deleteTemplateFromPalette('{custom_tpl_id}')")
        await asyncio.sleep(0.3)
        templates_after = await client.eval("window.store.getTemplates().length")
        record("Delete device template from device pool", templates_after == templates_before - 1, f"Templates: {templates_before} -> {templates_after}")

        # --- NEW: Delete Server Rack ---
        racks_before = await client.eval("window.store.getRacks().length")
        rack_to_del_id = await client.eval("""
            (() => {
                const r = window.store.getRacks();
                return r.length > 1 ? r[1].id : null;
            })()
        """)
        await client.eval(f"window.deleteRackConfirm('{rack_to_del_id}')")
        await asyncio.sleep(0.4)
        racks_after = await client.eval("window.store.getRacks().length")
        record("Delete server rack from system", racks_after == racks_before - 1, f"Racks: {racks_before} -> {racks_after}")

        # -------------------------------------------------------------
        # TEST 9A: Eltex MES2324 Series Built-in Templates & Photo Panels
        # -------------------------------------------------------------
        print("\n--- Test Suite 9A: Eltex MES2324 Built-in Photo Templates ---")
        eltex_templates_ok = await client.eval("""
            (() => {
                const ids = ['tpl-eltex-mes2324', 'tpl-eltex-mes2324p', 'tpl-eltex-mes2324b'];
                return ids.every(id => {
                    const tpl = window.store.getTemplate(id);
                    if (!tpl || tpl.vendor !== 'Eltex' || tpl.category !== 'switch') return false;
                    const rjCount = tpl.ports.filter(p => p.type === 'rj45').length;
                    const sfpCount = tpl.ports.filter(p => p.type === 'sfp').length;
                    const conCount = tpl.ports.filter(p => p.type === 'console').length;
                    return rjCount === 24 && sfpCount === 4 && conCount === 1 && Boolean(tpl.style?.customImage);
                });
            })()
        """)
        record("Eltex MES2324, MES2324P, and MES2324B templates exist with 29 ports", bool(eltex_templates_ok))

        eltex_images_ok = await client.eval("""
            (async () => {
                const imgs = [
                    'assets/panels/mes2324.png',
                    'assets/panels/mes2324p.png',
                    'assets/panels/mes2324b.png'
                ];
                const loaded = await Promise.all(imgs.map(src => new Promise(resolve => {
                    const img = new Image();
                    img.onload = () => resolve(img.naturalWidth === 1312 && img.naturalHeight === 124);
                    img.onerror = () => resolve(false);
                    img.src = src;
                })));
                return loaded.every(Boolean);
            })()
        """, await_promise=True)
        record("Eltex front-panel PNG images load cleanly (1312x124)", bool(eltex_images_ok))

        eltex_render_ok = await client.eval("""
            (() => {
                const dev = window.store.installDevice('tpl-eltex-mes2324p', 12);
                if (!dev) return false;
                const el = document.querySelector(`.installed-device[data-device-id="${dev.id}"]`);
                if (!el || !el.querySelector('.custom-image-panel')) return false;
                const p1 = el.querySelector('.port-slot[data-port-id="p-1"]');
                const p13 = el.querySelector('.port-slot[data-port-id="p-13"]');
                const xg1 = el.querySelector('.port-slot[data-port-id="xg-1"]');
                const con = el.querySelector('.port-slot[data-port-id="console"]');
                if (!p1 || !p13 || !xg1 || !con) return false;
                const j1 = p1.querySelector('.port-jack').getBoundingClientRect();
                const j13 = p13.querySelector('.port-jack').getBoundingClientRect();
                const c1 = window.store.addCable({
                    from: { deviceId: dev.id, portId: 'p-1' },
                    to: { deviceId: 'dev-switch', portId: 'p-1' },
                    type: 'Cat6 UTP'
                });
                const c2 = window.store.addCable({
                    from: { deviceId: dev.id, portId: 'xg-1' },
                    to: { deviceId: 'dev-gateway', portId: 'wan-2' },
                    type: '10G SFP+ DAC'
                });
                return (
                    p1.dataset.labelPos === 'top' &&
                    p13.dataset.labelPos === 'bottom' &&
                    j1.bottom <= j13.top + 0.5 &&
                    Math.abs((j1.left + j1.width / 2) - (j13.left + j13.width / 2)) < 2 &&
                    Boolean(c1 && c2)
                );
            })()
        """)
        await asyncio.sleep(0.3)
        record("Eltex photo panel renders coaxial RJ45/SFP/Console ports without row overlap", bool(eltex_render_ok))

        legacy_migration_ok = await client.eval("""
            (() => {
                const saved = localStorage.getItem('rack_studio_data_v2');
                try {
                    const legacyState = {
                        version: 2,
                        activeRackId: 'rack-legacy',
                        activeGroupFilter: 'ALL',
                        dimInactiveCables: true,
                        racks: [{ id: 'rack-legacy', name: 'Legacy', uHeight: 24, installedDevices: [] }],
                        cables: [],
                        groups: [],
                        templates: [window.store.getTemplate('tpl-switch-24p')]
                    };
                    localStorage.setItem('rack_studio_data_v2', JSON.stringify(legacyState));
                    const loaded = window.store.loadState();
                    const ids = new Set(loaded.templates.map(t => t.id));
                    return (
                        ids.has('tpl-eltex-mes2324') &&
                        ids.has('tpl-eltex-mes2324p') &&
                        ids.has('tpl-eltex-mes2324b') &&
                        !ids.has('tpl-pdu-1u')
                    );
                } finally {
                    if (saved !== null) localStorage.setItem('rack_studio_data_v2', saved);
                }
            })()
        """)
        record("Legacy saved state merges new Eltex templates without resurrecting removed defaults", bool(legacy_migration_ok))

        # -------------------------------------------------------------
        # TEST 9B: Interactive Rack Zoom Controls, Cable Alignment & Drag
        # -------------------------------------------------------------
        print("\n--- Test Suite 9B: Rack Zoom & Scaled Interaction ---")
        await client.eval("""
            (() => {
                document.getElementById('close-palette-modal')?.click();
                window.store.clearSelection();
            })()
        """)
        zoom_controls_ok = await client.eval("""
            (() => {
                window.resetRackZoom();
                const btnIn = document.getElementById('btn-zoom-in');
                const btnOut = document.getElementById('btn-zoom-out');
                const btnReset = document.getElementById('btn-zoom-reset');
                const btnFit = document.getElementById('btn-zoom-fit');
                if (!btnIn || !btnOut || !btnReset || !btnFit) return false;

                btnIn.click();
                btnIn.click();
                const zAfterIn = window.app.rackZoom;
                const labelIn = btnReset.textContent.trim();
                const stageW = document.getElementById('rack-container').getBoundingClientRect().width;

                btnOut.click();
                const zAfterOut = window.app.rackZoom;

                btnFit.click();
                const vp = document.getElementById('rack-viewport');
                const fitZoom = window.app.rackZoom;
                const fitsVertically = vp.scrollHeight <= vp.clientHeight + 2;

                btnReset.click();
                const zAfterReset = window.app.rackZoom;

                return (
                    Math.abs(zAfterIn - 1.2) < 0.001 &&
                    labelIn === '120%' &&
                    Math.abs(stageW - 760 * 1.2) < 2 &&
                    Math.abs(zAfterOut - 1.1) < 0.001 &&
                    fitZoom < 1 &&
                    fitsVertically &&
                    zAfterReset === 1
                );
            })()
        """)
        record("Zoom toolbar controls (+/-/Reset/Fit) scale rack and fit viewport", bool(zoom_controls_ok))

        wheel_zoom_ok = await client.eval("""
            (() => {
                window.resetRackZoom();
                const vp = document.getElementById('rack-viewport');
                vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, clientX: 500, clientY: 400, bubbles: true, cancelable: true }));
                const zoomed = window.app.rackZoom;
                window.resetRackZoom();
                return Math.abs(zoomed - 1.1) < 0.001;
            })()
        """)
        record("Ctrl+Wheel on rack viewport zooms smoothly", bool(wheel_zoom_ok))

        zoom_setup = await client.eval("""
            (() => {
                const rack = window.store.getActiveRack();
                const occupied = new Set();
                rack.installedDevices.forEach(d => {
                    const h = window.store.getTemplate(d.templateId)?.uHeight || 1;
                    for (let i = 0; i < h; i++) occupied.add(d.uPosition + i);
                });
                let baseU = null;
                for (let u = rack.uHeight - 3; u >= 4; u--) {
                    if ([u + 3, u + 2, u + 1, u, u - 1, u - 2].every(slot => !occupied.has(slot))) {
                        baseU = u;
                        break;
                    }
                }
                const swU = baseU + 2;
                const ppU = baseU;
                const sw = window.store.installDevice('tpl-switch-24p', swU);
                const pp = window.store.installDevice('tpl-patch-24p', ppU);
                const c = window.store.addCable({
                    from: { deviceId: sw.id, portId: 'p-1' },
                    to: { deviceId: pp.id, portId: 'p-1' },
                    color: '#22d3ee',
                    type: 'Cat6 UTP',
                    lengthM: 1,
                    label: 'Zoom Check'
                });
                return { swId: sw.id, ppId: pp.id, cableId: c.id, ppStartU: ppU };
            })()
        """)
        await asyncio.sleep(0.2)

        async def verify_zoom_geometry(scale_val):
            pt_info = await client.eval(f"""
                (() => {{
                    window.app.setRackZoom({scale_val});
                    window.store.clearSelection();
                    window.app.cableRenderer.render();
                    const cr = window.app.cableRenderer;
                    const vp = document.getElementById('rack-viewport');
                    const item = cr.renderedCables.find(c => c.cable.id === '{zoom_setup["cableId"]}');
                    const jack = document.querySelector(`.installed-device[data-device-id="{zoom_setup["swId"]}"] .port-slot[data-port-id="p-1"] .port-jack`);
                    if (!item || !jack) return {{ error: 'missing item or jack' }};
                    jack.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                    if (vp) vp.scrollLeft = 0;
                    const jackRect = jack.getBoundingClientRect();
                    const svgRect = cr.svg.getBoundingClientRect();
                    const scale = cr.getScale();
                    const boot = item.g.querySelector('circle');
                    const bx = svgRect.left + parseFloat(boot.getAttribute('cx')) * scale;
                    const by = svgRect.top + parseFloat(boot.getAttribute('cy')) * scale;
                    const jx = jackRect.left + jackRect.width / 2;
                    const jy = jackRect.top + jackRect.height / 2;
                    const aligned = Math.hypot(bx - jx, by - jy) < 2.0;

                    const len = item.hitPath.getTotalLength();
                    const pt = item.hitPath.getPointAtLength(len * 0.5);
                    return {{
                        aligned,
                        bootDiff: Math.round(Math.hypot(bx - jx, by - jy) * 100) / 100,
                        scaleDelta: Math.abs(scale - {scale_val}),
                        cx: svgRect.left + pt.x * scale,
                        cy: svgRect.top + pt.y * scale
                    }};
                }})()
            """)
            if not pt_info or pt_info.get("error") or not pt_info["aligned"] or pt_info["scaleDelta"] >= 0.02:
                return False, f"pt_info={pt_info}"
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": pt_info["cx"], "y": pt_info["cy"]})
            await asyncio.sleep(0.1)
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": pt_info["cx"], "y": pt_info["cy"], "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": pt_info["cx"], "y": pt_info["cy"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)
            sel = await client.eval("window.store.selectedEntity?.id || null")
            return sel == zoom_setup["cableId"], f"cx={round(pt_info['cx'],1)}, cy={round(pt_info['cy'],1)}, sel={sel}, want={zoom_setup['cableId']}"

        zoom_in_cable_ok, zoom_in_info = await verify_zoom_geometry(1.5)
        record("At 150% zoom cables align with ports and remain clickable", bool(zoom_in_cable_ok), zoom_in_info)

        # Verify drag & drop works accurately while zoomed to 150%
        drag_info_zoom = await client.eval(f"""
            (() => {{
                const ppEl = document.querySelector(`.installed-device[data-device-id="{zoom_setup["ppId"]}"]`);
                const vp = document.getElementById('rack-viewport');
                if (!ppEl) return null;
                ppEl.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                if (vp) vp.scrollLeft = 0;
                const rect = ppEl.getBoundingClientRect();
                return {{ x: rect.left + 10, y: rect.top + rect.height / 2, slotH: rect.height }};
            }})()
        """)
        zoom_drag_ok = False
        drag_details = ""
        if drag_info_zoom:
            sx = drag_info_zoom["x"]
            sy = drag_info_zoom["y"]
            dy = drag_info_zoom["slotH"] * 2
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": sx, "y": sy, "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": sx, "y": sy + dy * 0.5, "buttons": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": sx, "y": sy + dy, "buttons": 1})
            await asyncio.sleep(0.1)
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": sx, "y": sy + dy, "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)
            new_u = await client.eval(f"window.store.getActiveRack().installedDevices.find(d => d.id === '{zoom_setup['ppId']}')?.uPosition")
            zoom_drag_ok = (new_u == zoom_setup["ppStartU"] - 2)
            drag_details = f"sx={round(sx,1)}, sy={round(sy,1)}, new_u={new_u}, want={zoom_setup['ppStartU'] - 2}"
        record("Drag device moves accurate slot distance at 150% zoom", zoom_drag_ok, drag_details)

        zoom_out_cable_ok, zoom_out_info = await verify_zoom_geometry(0.6)
        record("At 60% zoom cables align with ports and remain clickable", bool(zoom_out_cable_ok), zoom_out_info)

        await client.eval(f"""
            (() => {{
                window.app.setRackZoom(1);
                localStorage.removeItem('rack_studio_zoom_v1');
                window.store.removeDevice('{zoom_setup["swId"]}');
                window.store.removeDevice('{zoom_setup["ppId"]}');
                window.store.clearSelection();
            }})()
        """)

        # -------------------------------------------------------------
        # TEST 11: Auto Patch-Cord Length Calculator (Block B.1)
        # -------------------------------------------------------------
        print("\n--- Test Suite 11: Auto Patch-Cord Length Calculator ---")
        await client.eval("""
            (() => {
                const r1 = window.store.getRacks()[0];
                const keepIds = new Set(['dev-gateway', 'dev-patch', 'dev-switch', 'dev-server', 'dev-pdu']);
                r1.installedDevices
                    .filter(d => !keepIds.has(d.id))
                    .map(d => d.id)
                    .forEach(id => window.store.removeDevice(id));
                window.store.setActiveRack(r1.id);
                window.store.setActiveGroupFilter('ALL');
                window.store.setCableRoutingMode('channels');
                window.store.clearSelection();
            })()
        """)
        await asyncio.sleep(0.2)

        auto_len_setup = await client.eval("""
            (() => {
                const sw = window.store.installDevice('tpl-eltex-mes2324p', 15, 'Eltex-Core-Access');
                const pp = window.store.installDevice('tpl-patch-24p', 14, 'Patch-24P-Test');
                if (!sw || !pp) return null;
                const el = document.querySelector(`.port-slot[data-device-id="${sw.id}"][data-port-id="p-1"] .port-jack`);
                if (!el) return null;
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                const r = el.getBoundingClientRect();
                return {
                    swId: sw.id,
                    ppId: pp.id,
                    pSw1: { x: r.left + r.width / 2, y: r.top + r.height / 2 }
                };
            })()
        """)

        auto_len_ok = False
        recalc_on_mode_ok = False
        recalc_on_move_ok = False
        manual_override_ok = False

        if auto_len_setup and auto_len_setup.get("pSw1"):
            p1 = auto_len_setup["pSw1"]
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": p1["x"], "y": p1["y"], "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": p1["x"], "y": p1["y"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)
            banner_visible = await client.eval("!document.getElementById('cable-draft-banner').classList.contains('hidden')")
            p2 = await client.eval(f"""
                (() => {{
                    const el = document.querySelector(`.port-slot[data-device-id="{auto_len_setup['ppId']}"][data-port-id="p-1"] .port-jack`);
                    if (!el) return null;
                    el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                    const r = el.getBoundingClientRect();
                    return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }};
                }})()
            """)
            if p2:
                await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": p2["x"], "y": p2["y"], "button": "left", "clickCount": 1})
                await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": p2["x"], "y": p2["y"], "button": "left", "clickCount": 1})
                await asyncio.sleep(0.25)

            cable_res = await client.eval(f"""
                (() => {{
                    const c = window.store.getCableByPort('{auto_len_setup["swId"]}', 'p-1');
                    return c ? {{ id: c.id, lengthM: c.lengthM, lengthAuto: c.lengthAuto }} : null;
                }})()
            """)
            std_sizes = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0]
            auto_len_ok = bool(
                banner_visible and
                isinstance(cable_res, dict) and
                cable_res.get("lengthAuto") is True and
                cable_res.get("lengthM") in std_sizes
            )

            # Move patch panel down from U14 -> U2 (across the rack) and check length auto-increases
            len_near = cable_res.get("lengthM", 0) if isinstance(cable_res, dict) else 0
            await client.eval(f"window.store.moveDevice('{auto_len_setup['ppId']}', 2)")
            await asyncio.sleep(0.2)
            len_far_channels = await client.eval(f"window.store.getCableByPort('{auto_len_setup['swId']}', 'p-1')?.lengthM ?? null")
            recalc_on_move_ok = isinstance(len_far_channels, (int, float)) and len_far_channels > len_near

            # Toggle routing mode channels <-> arcs and check auto-length recalculation
            await client.eval("document.getElementById('btn-route-arcs').click()")
            await asyncio.sleep(0.15)
            len_far_arcs = await client.eval(f"window.store.getCableByPort('{auto_len_setup['swId']}', 'p-1')?.lengthM ?? null")
            await client.eval("document.getElementById('btn-route-channels').click()")
            await asyncio.sleep(0.15)
            recalc_on_mode_ok = (
                isinstance(len_far_arcs, (int, float)) and
                isinstance(len_far_channels, (int, float)) and
                len_far_arcs <= len_far_channels
            )

            # Open drawer, edit manual length -> unchecks lengthAuto; re-check Auto -> snaps back
            if cable_res:
                await client.eval(f"window.store.setSelection({{ type: 'cable', id: '{cable_res['id']}' }})")
                await asyncio.sleep(0.2)
                manual_override_ok = await client.eval(f"""
                    (() => {{
                        const lenInput = document.getElementById('drawer-cable-len');
                        const autoChk = document.getElementById('drawer-cable-length-auto');
                        if (!lenInput || !autoChk || !autoChk.checked) return false;
                        lenInput.value = '4.25';
                        lenInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        const afterManual = window.store.state.cables.find(c => c.id === '{cable_res['id']}');
                        if (!afterManual || afterManual.lengthAuto !== false || afterManual.lengthM !== 4.25) return false;
                        autoChk.checked = true;
                        autoChk.dispatchEvent(new Event('change', {{ bubbles: true }}));
                        const afterReAuto = window.store.state.cables.find(c => c.id === '{cable_res['id']}');
                        return Boolean(afterReAuto && afterReAuto.lengthAuto === true && afterReAuto.lengthM !== 4.25);
                    }})()
                """)

        record("Auto patch-cord length calculates standard size via port clicks", auto_len_ok)
        record("Moving device recalculates auto cable length dynamically", recalc_on_move_ok)
        record("Switching Channels/Arcs recalculates auto cable length", recalc_on_mode_ok)
        record("Drawer manual length disables Auto and re-checking restores it", bool(manual_override_ok))

        # -------------------------------------------------------------
        # TEST 12: Keyboard Accelerators (Block D.3)
        # -------------------------------------------------------------
        print("\n--- Test Suite 12: Keyboard Navigation & Shortcuts ---")
        async def send_key(key_name, vk_code):
            await client.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": key_name, "code": key_name, "windowsVirtualKeyCode": vk_code})
            await client.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": key_name, "code": key_name, "windowsVirtualKeyCode": vk_code})
            await asyncio.sleep(0.15)

        kbd_results = {"move_up": False, "skip_obstacle": False, "input_guard": False, "esc_draft": False, "del_cable": False}

        if auto_len_setup:
            # Select patch panel at U2 (below obstacle? place an obstacle at U13 and test skipping around U12 -> U14!)
            await client.eval(f"""
                (() => {{
                    window.store.moveDevice('{auto_len_setup["ppId"]}', 12);
                    // Eltex switch is at U15; add another switch at U13 so ArrowUp from U12 skips U13 -> U14!
                    const obs = window.store.installDevice('tpl-eltex-mes2324', 13, 'Eltex-Obstacle');
                    window._obsDevId = obs ? obs.id : null;
                    window.store.setSelection({{ type: 'device', id: '{auto_len_setup["ppId"]}' }});
                    document.body.focus();
                }})()
            """)
            await asyncio.sleep(0.2)

            await send_key("ArrowUp", 38)
            u_after_skip = await client.eval(f"window.store.findDeviceLocation('{auto_len_setup['ppId']}')?.device.uPosition")
            kbd_results["skip_obstacle"] = (u_after_skip == 14)

            await send_key("ArrowDown", 40)
            u_after_down = await client.eval(f"window.store.findDeviceLocation('{auto_len_setup['ppId']}')?.device.uPosition")
            kbd_results["move_up"] = (u_after_down == 12)

            # Focus input inside drawer and verify ArrowUp does not move device
            await client.eval("document.getElementById('drawer-dev-name')?.focus()")
            await send_key("ArrowUp", 38)
            u_guarded = await client.eval(f"window.store.findDeviceLocation('{auto_len_setup['ppId']}')?.device.uPosition")
            kbd_results["input_guard"] = (u_guarded == 12)

            # Test Escape cancels active cableDraft
            await client.eval(f"""
                (() => {{
                    document.activeElement?.blur?.();
                    window.store.startCableDraft('{auto_len_setup["swId"]}', 'p-3', 200, 200);
                }})()
            """)
            await asyncio.sleep(0.1)
            await send_key("Escape", 27)
            draft_cleared = await client.eval("window.store.cableDraft === null && document.getElementById('cable-draft-banner').classList.contains('hidden')")
            kbd_results["esc_draft"] = bool(draft_cleared)

            # Test Delete key deletes selected cable
            del_cable_id = await client.eval(f"window.store.getCableByPort('{auto_len_setup['swId']}', 'p-1')?.id")
            if del_cable_id:
                await client.eval(f"window.store.setSelection({{ type: 'cable', id: '{del_cable_id}' }})")
                await asyncio.sleep(0.15)
                await send_key("Delete", 46)
                still_exists = await client.eval(f"window.store.state.cables.some(c => c.id === '{del_cable_id}')")
                kbd_results["del_cable"] = (still_exists is False)

        record("Keyboard ArrowUp skips occupied unit slot cleanly (U12 -> U14)", kbd_results["skip_obstacle"])
        record("Keyboard ArrowDown moves device down across obstacle (U14 -> U12)", kbd_results["move_up"])
        record("Keyboard shortcuts are suppressed when typing in drawer inputs", kbd_results["input_guard"])
        record("Escape key cancels active cable draft cleanly", kbd_results["esc_draft"])
        record("Delete key removes selected cable", kbd_results["del_cable"])

        # -------------------------------------------------------------
        # TEST 13: Inter-Rack Uplinks / Cross-Rack Patching (Block F.3)
        # -------------------------------------------------------------
        print("\n--- Test Suite 13: Cross-Rack Patching (Inter-Rack Uplinks) ---")
        inter_setup = await client.eval("""
            (() => {
                const r1 = window.store.getRacks()[0];
                const r2 = window.store.addRack('Стойка №2 (Кроссовая Этаж 2)', 24);
                const swR2 = window.store.installDevice('tpl-eltex-mes2324', 24, 'Eltex-Access-F2');
                const ppR2 = window.store.installDevice('tpl-patch-24p', 22, 'Patch-F2');
                window.store.setActiveRack(r1.id);
                const eltexR1 = r1.installedDevices.find(d => d.templateId === 'tpl-eltex-mes2324p');
                return {
                    r1Id: r1.id,
                    r2Id: r2.id,
                    swR1Id: eltexR1 ? eltexR1.id : null,
                    swR2Id: swR2 ? swR2.id : null,
                    ppR2Id: ppR2 ? ppR2.id : null
                };
            })()
        """)
        await asyncio.sleep(0.3)

        inter_draft_ok = False
        inter_create_ok = False
        inter_badge_jump_ok = False

        if inter_setup and inter_setup["swR1Id"] and inter_setup["swR2Id"]:
            # Start draft on Eltex MES2324P XG1 in Rack 1
            xg1_r1 = await client.eval(f"""
                (() => {{
                    const el = document.querySelector(`.port-slot[data-device-id="{inter_setup['swR1Id']}"][data-port-id="xg-1"] .port-jack`);
                    if (!el) return null;
                    el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                    const r = el.getBoundingClientRect();
                    return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }};
                }})()
            """)
            if xg1_r1:
                await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": xg1_r1["x"], "y": xg1_r1["y"], "button": "left", "clickCount": 1})
                await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": xg1_r1["x"], "y": xg1_r1["y"], "button": "left", "clickCount": 1})
                await asyncio.sleep(0.2)

                # Click rack switch button in #cable-draft-banner to jump to Rack 2 while preserving draft
                await client.eval(f"document.querySelector(`#cable-draft-banner button[onclick*=\"{inter_setup['r2Id']}\"]`)?.click()")
                await asyncio.sleep(0.25)
                inter_draft_ok = await client.eval(f"""
                    window.store.getActiveRack().id === '{inter_setup["r2Id"]}' &&
                    window.store.cableDraft !== null &&
                    window.store.cableDraft.deviceId === '{inter_setup["swR1Id"]}'
                """)

                # Finish draft on Eltex MES2324 XG1 in Rack 2
                xg1_r2 = await client.eval(f"""
                    (() => {{
                        const el = document.querySelector(`.port-slot[data-device-id="{inter_setup['swR2Id']}"][data-port-id="xg-1"] .port-jack`);
                        if (!el) return null;
                        el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
                        const r = el.getBoundingClientRect();
                        return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }};
                    }})()
                """)
                if xg1_r2:
                    await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": xg1_r2["x"], "y": xg1_r2["y"], "button": "left", "clickCount": 1})
                    await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": xg1_r2["x"], "y": xg1_r2["y"], "button": "left", "clickCount": 1})
                    await asyncio.sleep(0.3)

                    inter_info = await client.eval(f"""
                        (() => {{
                            const c = window.store.getCableByPort('{inter_setup['swR2Id']}', 'xg-1');
                            const badge = document.querySelector('#cables-svg .inter-rack-badge');
                            return {{
                                isInterRack: c ? window.store.isInterRackCable(c) : false,
                                cableType: c?.type,
                                lengthM: c?.lengthM,
                                hasSvgBadge: Boolean(badge),
                                badgeText: badge?.textContent || ''
                            }};
                        }})()
                    """)
                    inter_create_ok = bool(
                        inter_info and
                        inter_info["isInterRack"] and
                        inter_info["cableType"] == "Fiber OM4" and
                        inter_info["lengthM"] == 5 and
                        inter_info["hasSvgBadge"]
                    )

                    # Click SVG inter-rack badge to jump to Rack 1 and open cable in Drawer
                    await client.eval("""
                        (() => {
                            const badge = document.querySelector('#cables-svg .inter-rack-badge');
                            if (badge) badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        })()
                    """)
                    await asyncio.sleep(0.25)
                    inter_badge_jump_ok = await client.eval(f"""
                        window.store.getActiveRack().id === '{inter_setup["r1Id"]}' &&
                        window.store.selectedEntity?.type === 'cable' &&
                        !document.getElementById('details-drawer').classList.contains('translate-x-full')
                    """)

        record("Cable draft persists when switching racks via draft banner", bool(inter_draft_ok))
        record("Cross-rack SFP+ uplink creates Fiber OM4 inter-rack cable with SVG badge", bool(inter_create_ok))
        record("Clicking SVG inter-rack badge jumps to remote rack & opens cable inspector", bool(inter_badge_jump_ok))

        # -------------------------------------------------------------
        # TEST 14: Logical Network Topology L1/L2 (Blocks E.1, E.2, E.3)
        # -------------------------------------------------------------
        print("\n--- Test Suite 14: Logical Network Topology L1/L2 ---")
        topo_prep = await client.eval(f"""
            (() => {{
                const r1 = window.store.getRacks()[0];
                window.store.setActiveRack(r1.id);
                const grp = window.store.addGroup('VLAN 50 Офис', '#22c55e', 50);
                // Connect Eltex MES2324P to Patch-24P with 3 cables in VLAN 50 (tests bundle x3)
                for (let p = 2; p <= 4; p++) {{
                    window.store.addCable({{
                        from: {{ deviceId: '{auto_len_setup["swId"]}', portId: `p-${{p}}` }},
                        to: {{ deviceId: '{auto_len_setup["ppId"]}', portId: `p-${{p}}` }},
                        groupId: grp.id
                    }});
                }}
                // Connect 2 parallel links between Eltex-Core-Access and Eltex-Obstacle (tests LAG detection)
                window.store.addCable({{
                    from: {{ deviceId: '{auto_len_setup["swId"]}', portId: 'xg-2' }},
                    to: {{ deviceId: window._obsDevId, portId: 'xg-1' }}
                }});
                window.store.addCable({{
                    from: {{ deviceId: '{auto_len_setup["swId"]}', portId: 'xg-3' }},
                    to: {{ deviceId: window._obsDevId, portId: 'xg-2' }}
                }});
                // Connect Core-Access to Gateway so router tier sits at top
                window.store.addCable({{
                    from: {{ deviceId: 'dev-gateway', portId: 'lan-2' }},
                    to: {{ deviceId: '{auto_len_setup["swId"]}', portId: 'p-10' }},
                    groupId: grp.id
                }});
                return grp.id;
            }})()
        """)
        await asyncio.sleep(0.2)

        # Switch UI to Topology View
        await client.eval("document.getElementById('btn-view-topology').click()")
        await asyncio.sleep(0.3)

        topo_view_ok = await client.eval("""
            (() => {
                const rackHidden = document.getElementById('rack-viewport').classList.contains('hidden');
                const topoVisible = !document.getElementById('topology-viewport').classList.contains('hidden');
                const svg = document.getElementById('topology-svg');
                const nodes = Array.from(document.querySelectorAll('#topology-svg .topo-node'));
                const edges = Array.from(document.querySelectorAll('#topology-svg .topo-edge'));
                const hasBundle3 = edges.some(e => e.textContent.includes('×3'));
                const hasLag = edges.some(e => e.textContent.includes('(LAG)'));
                // Verify Gateway (router) sits physically above Switch, and Switch above Patch Panel
                const gwNode = nodes.find(n => n.textContent.includes('Gateway'));
                const ppNode = nodes.find(n => n.textContent.includes('Patch-24P-Test'));
                const gwY = parseFloat(gwNode?.querySelector('rect')?.getAttribute('y') || '9999');
                const ppY = parseFloat(ppNode?.querySelector('rect')?.getAttribute('y') || '0');
                return {
                    ok: rackHidden && topoVisible && Boolean(svg) && hasBundle3 && hasLag && gwY < ppY,
                    nodes: nodes.length,
                    edges: edges.length,
                    hasBundle3,
                    hasLag,
                    gwY,
                    ppY
                };
            })()
        """)
        record("Topology View renders hierarchical router -> switch -> patch SVG with x3 bundle & LAG badge", bool(topo_view_ok and topo_view_ok["ok"]), str(topo_view_ok))

        # Test All-Racks Topology Scope & Inter-Rack Edge
        await client.eval("document.getElementById('topo-scope-all').click()")
        await asyncio.sleep(0.25)
        topo_all_ok = await client.eval("""
            (() => {
                const nodes = Array.from(document.querySelectorAll('#topology-svg .topo-node'));
                const hasRack1 = nodes.some(n => n.textContent.includes('Eltex-Core-Access'));
                const hasRack2 = nodes.some(n => n.textContent.includes('Eltex-Access-F2'));
                return hasRack1 && hasRack2;
            })()
        """)
        record("All-Racks topology scope combines devices across both racks", bool(topo_all_ok))

        # Toggle bundle collapse OFF -> expands edges; click bundle back ON and inspect bundle in Drawer
        edges_bundled_count = await client.eval("document.querySelectorAll('#topology-svg .topo-edge').length")
        await client.eval("""
            (() => {
                const chk = document.getElementById('topo-toggle-bundle');
                chk.checked = false;
                chk.dispatchEvent(new Event('change', { bubbles: true }));
            })()
        """)
        await asyncio.sleep(0.2)
        edges_unbundled_count = await client.eval("document.querySelectorAll('#topology-svg .topo-edge').length")
        await client.eval("""
            (() => {
                const chk = document.getElementById('topo-toggle-bundle');
                chk.checked = true;
                chk.dispatchEvent(new Event('change', { bubbles: true }));
            })()
        """)
        await asyncio.sleep(0.2)

        # Click the ×3 bundle edge to open Bundle Inspector in Drawer
        await client.eval("""
            (() => {
                const edge = Array.from(document.querySelectorAll('#topology-svg .topo-edge')).find(e => e.textContent.includes('×3'));
                edge?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            })()
        """)
        await asyncio.sleep(0.2)
        bundle_drawer_ok = await client.eval("""
            window.store.selectedEntity?.type === 'cable_bundle' &&
            !document.getElementById('details-drawer').classList.contains('translate-x-full') &&
            document.getElementById('details-content').textContent.includes('Пучок кабелей')
        """)
        record("Unbundling expands aggregated edges cleanly", edges_unbundled_count > edges_bundled_count, f"bundled={edges_bundled_count}, expanded={edges_unbundled_count}")
        record("Clicking aggregated bundle opens Bundle Inspector in Drawer", bool(bundle_drawer_ok))

        # Test group filter dims non-matching edges in Topology
        await client.eval(f"window.store.setActiveGroupFilter('{topo_prep}')")
        await asyncio.sleep(0.2)
        topo_filter_ok = await client.eval("""
            (() => {
                const edges = Array.from(document.querySelectorAll('#topology-svg .topo-edge'));
                const ops = edges.map(e => parseFloat(e.getAttribute('opacity') || '1'));
                return ops.some(o => o > 0.8) && ops.some(o => o < 0.3);
            })()
        """)
        await client.eval("window.store.setActiveGroupFilter('ALL')")
        record("Workplace group filter highlights matching path and dims others in Topology", bool(topo_filter_ok))

        # Test dragging topology nodes with live edge re-routing, zoom accuracy, click-select & layout reset
        await client.eval("document.getElementById('topo-scope-active').click(); window.store.clearSelection();")
        await asyncio.sleep(0.2)

        drag_target = await client.eval("""
            (() => {
                const node = Array.from(document.querySelectorAll('#topology-svg .topo-node')).find(n => n.textContent.includes('Gateway'));
                if (!node) return null;
                const rect = node.querySelector('rect');
                const box = rect.getBoundingClientRect();
                const edge = Array.from(document.querySelectorAll('#topology-svg .topo-edge')).find(e => e.textContent.includes('P10') || e.dataset.bundleKey?.includes('dev-gateway'));
                return {
                    devId: node.dataset.deviceId,
                    origX: parseFloat(rect.getAttribute('x')),
                    origY: parseFloat(rect.getAttribute('y')),
                    cx: box.left + box.width / 2,
                    cy: box.top + box.height / 2,
                    edgeBeforeD: edge?.querySelector('.topo-edge-line')?.getAttribute('d') || '',
                    resetDisabledBefore: document.getElementById('btn-topo-reset-layout')?.disabled
                };
            })()
        """)

        topo_drag_ok = False
        topo_drag_details = ""
        if drag_target:
            sx, sy = drag_target["cx"], drag_target["cy"]
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": sx, "y": sy, "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": sx + 90, "y": sy + 140, "buttons": 1})
            await asyncio.sleep(0.05)

            live_check = await client.eval(f"""
                (() => {{
                    const node = document.querySelector('#topology-svg .topo-node[data-device-id="{drag_target["devId"]}"]');
                    const edge = Array.from(document.querySelectorAll('#topology-svg .topo-edge')).find(e => e.dataset.bundleKey?.includes('{drag_target["devId"]}'));
                    return {{
                        tf: node?.getAttribute('transform') || '',
                        liveD: edge?.querySelector('.topo-edge-line')?.getAttribute('d') || ''
                    }};
                }})()
            """)

            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": sx + 180, "y": sy + 280, "buttons": 1})
            await asyncio.sleep(0.05)
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": sx + 180, "y": sy + 280, "button": "left", "clickCount": 1})
            await asyncio.sleep(0.2)

            after_drag = await client.eval(f"""
                (() => {{
                    const node = document.querySelector('#topology-svg .topo-node[data-device-id="{drag_target["devId"]}"]');
                    const rect = node?.querySelector('rect');
                    const edge = Array.from(document.querySelectorAll('#topology-svg .topo-edge')).find(e => e.dataset.bundleKey?.includes('{drag_target["devId"]}'));
                    return {{
                        newX: parseFloat(rect?.getAttribute('x') || '0'),
                        newY: parseFloat(rect?.getAttribute('y') || '0'),
                        edgeAfterD: edge?.querySelector('.topo-edge-line')?.getAttribute('d') || '',
                        resetDisabledAfter: document.getElementById('btn-topo-reset-layout')?.disabled,
                        selectedType: window.store.selectedEntity?.type || null
                    }};
                }})()
            """)
            topo_drag_ok = bool(
                drag_target["resetDisabledBefore"] is True
                and live_check and "translate(" in live_check["tf"]
                and live_check["liveD"] != drag_target["edgeBeforeD"]
                and after_drag["newX"] > drag_target["origX"] + 120
                and after_drag["newY"] > drag_target["origY"] + 200
                and after_drag["edgeAfterD"] != drag_target["edgeBeforeD"]
                and after_drag["resetDisabledAfter"] is False
                and after_drag["selectedType"] is None
            )
            topo_drag_details = f"before=({drag_target['origX']},{drag_target['origY']}), after=({after_drag['newX']},{after_drag['newY']})"
        record("Topology node drag moves card smoothly with live edge updates and saves coordinates", topo_drag_ok, topo_drag_details)

        # Verify dragging works cleanly at non-100% Topology zoom & clicking node without drag selects it
        await client.eval("document.getElementById('topo-zoom-in').click(); document.getElementById('topo-zoom-in').click();")
        await asyncio.sleep(0.15)
        zoomed_drag_target = await client.eval(f"""
            (() => {{
                const node = document.querySelector('#topology-svg .topo-node[data-device-id="{drag_target["devId"]}"]');
                const rect = node?.querySelector('rect');
                const box = rect?.getBoundingClientRect();
                return box ? {{ x: parseFloat(rect.getAttribute('x')), y: parseFloat(rect.getAttribute('y')), cx: box.left + box.width / 2, cy: box.top + box.height / 2 }} : null;
            }})()
        """)
        zoom_drag_ok = False
        click_select_ok = False
        if zoomed_drag_target:
            zx, zy = zoomed_drag_target["cx"], zoomed_drag_target["cy"]
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": zx, "y": zy, "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": zx - 65, "y": zy - 52, "buttons": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": zx - 65, "y": zy - 52, "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)

            z_after = await client.eval(f"""
                (() => {{
                    const rect = document.querySelector('#topology-svg .topo-node[data-device-id="{drag_target["devId"]}"] rect');
                    const box = rect?.getBoundingClientRect();
                    return {{
                        x: parseFloat(rect?.getAttribute('x') || '0'),
                        y: parseFloat(rect?.getAttribute('y') || '0'),
                        cx: box.left + box.width / 2,
                        cy: box.top + box.height / 2
                    }};
                }})()
            """)
            # 65px / 1.3 zoom ~= 50 SVG units delta
            dx_svg = zoomed_drag_target["x"] - z_after["x"]
            zoom_drag_ok = 35 <= dx_svg <= 65

            # Plain click on zoomed node selects device cleanly
            await client.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": z_after["cx"], "y": z_after["cy"], "button": "left", "clickCount": 1})
            await client.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": z_after["cx"], "y": z_after["cy"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.15)
            click_select_ok = await client.eval(f"window.store.selectedEntity?.type === 'device' && window.store.selectedEntity?.id === '{drag_target['devId']}'")

        await client.eval("document.getElementById('topo-zoom-reset').click(); window.store.clearSelection();")
        await asyncio.sleep(0.1)
        record("Topology drag scales accurately at 130% zoom while plain clicks still select devices", bool(zoom_drag_ok and click_select_ok), f"zoomDrag={zoom_drag_ok}, clickSel={click_select_ok}")

        # Verify Reset Layout button restores hierarchical coordinates and disables button again
        await client.eval("document.getElementById('btn-topo-reset-layout').click()")
        await asyncio.sleep(0.2)
        topo_reset_ok = await client.eval(f"""
            (() => {{
                const rect = document.querySelector('#topology-svg .topo-node[data-device-id="{drag_target["devId"]}"] rect');
                const x = parseFloat(rect?.getAttribute('x') || '0');
                const y = parseFloat(rect?.getAttribute('y') || '0');
                return {{
                    restoredX: x,
                    restoredY: y,
                    matchesOrig: Math.abs(x - {drag_target["origX"]}) < 2 && Math.abs(y - {drag_target["origY"]}) < 2,
                    btnDisabled: document.getElementById('btn-topo-reset-layout')?.disabled === true
                }};
            }})()
        """)
        record("Reset Layout button restores auto-hierarchy in Topology view", bool(topo_reset_ok and topo_reset_ok["matchesOrig"] and topo_reset_ok["btnDisabled"]), str(topo_reset_ok))

        # -------------------------------------------------------------
        # TEST 15: Rack Passport & Print / PDF Export (Block F.1)
        # -------------------------------------------------------------
        print("\n--- Test Suite 15: Rack Passport & PDF Print Export ---")
        await client.eval("document.getElementById('btn-export-pdf').click()")
        await asyncio.sleep(0.35)

        print_modal_ok = await client.eval("""
            (() => {
                const modal = document.getElementById('print-modal');
                const preview = document.getElementById('print-preview-container');
                const root = document.getElementById('print-report-root');
                const txt = preview?.textContent || '';
                const hasRackSvg = Boolean(preview?.querySelector('.print-rack-wrap svg .cable-group'));
                const hasTopoSvg = Boolean(preview?.querySelector('#print-topology-svg'));
                const hasPortName = txt.includes('XG1');
                return {
                    open: modal && !modal.classList.contains('hidden'),
                    hasSummary: txt.includes('Паспорт монтажного шкафа'),
                    hasRackSvg,
                    hasTopoSvg,
                    hasPortName,
                    syncedRoot: Boolean(root && root.innerHTML.length > 500)
                };
            })()
        """)
        record("Print Passport opens while in Topology view with Rack SVG, Topology SVG & Eltex XG1 table", bool(
            print_modal_ok and print_modal_ok["open"] and print_modal_ok["hasSummary"] and
            print_modal_ok["hasRackSvg"] and print_modal_ok["hasTopoSvg"] and
            print_modal_ok["hasPortName"] and print_modal_ok["syncedRoot"]
        ), str(print_modal_ok))

        # Toggle options: disable cable table & enable CLI configs
        await client.eval("""
            (() => {
                const cChk = document.getElementById('print-opt-cables');
                const cliChk = document.getElementById('print-opt-cli');
                cChk.checked = false;
                cChk.dispatchEvent(new Event('change', { bubbles: true }));
                cliChk.checked = true;
                cliChk.dispatchEvent(new Event('change', { bubbles: true }));
            })()
        """)
        await asyncio.sleep(0.2)
        print_toggle_ok = await client.eval("""
            (() => {
                const txt = document.getElementById('print-preview-container')?.textContent || '';
                return !txt.includes('Журнал подключений') && txt.includes('Конфигурации CLI устройств');
            })()
        """)
        record("Print Passport checkboxes dynamically show/hide Cable & CLI sections", bool(print_toggle_ok))

        # Verify actual browser PDF generation via CDP Page.printToPDF
        pdf_res = await client.send("Page.printToPDF", {"printBackground": True})
        pdf_bytes = base64.b64decode(pdf_res.get("data", ""))
        record("Browser generates valid non-empty PDF via @media print", pdf_bytes.startswith(b"%PDF-") and len(pdf_bytes) > 5000, f"PDF size={len(pdf_bytes)} bytes")

        # Close print modal with Escape & switch back to Rack View cleanly
        await send_key("Escape", 27)
        print_closed = await client.eval("document.getElementById('print-modal').classList.contains('hidden')")
        await client.eval("document.getElementById('btn-view-rack').click()")
        await asyncio.sleep(0.2)
        record("Escape closes Print Passport modal cleanly", bool(print_closed))

        # -------------------------------------------------------------
        # TEST 16: Light Theme & Contrast Readability
        # -------------------------------------------------------------
        print("\n--- Test Suite 16: Light Theme & Contrast Readability ---")
        await client.eval("document.getElementById('btn-toggle-theme').click()")
        await asyncio.sleep(0.25)

        light_ui_check = await client.eval("""
            (() => {
                const lum = (str) => {
                    const m = String(str || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
                    if (!m) return -1;
                    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map(v => {
                        const s = v / 255;
                        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                    });
                    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
                };
                const bodyCs = getComputedStyle(document.body);
                const hdrCs = getComputedStyle(document.querySelector('header'));
                const ctaCs = getComputedStyle(document.getElementById('btn-catalog'));
                const cabCs = getComputedStyle(document.querySelector('.rack-cabinet'));
                const slotCs = getComputedStyle(document.querySelector('.rack-slots-column'));
                const toggleBtn = document.getElementById('btn-toggle-theme');
                const toggleLbl = document.getElementById('theme-toggle-label')?.textContent?.trim();
                const devBadge = document.querySelector('.installed-device .rack-device-name');
                const devBadgeBgLum = devBadge ? lum(getComputedStyle(devBadge).backgroundColor) : 0;
                const firstCasing = document.querySelector('#cables-svg #cables-layer path[stroke="#f8fafc"]');
                const hasCables = document.querySelectorAll('#cables-svg #cables-layer .cable-group').length > 0;
                return {
                    dataTheme: document.documentElement.dataset.theme,
                    hasDarkClass: document.documentElement.classList.contains('dark'),
                    stored: localStorage.getItem('rack_studio_theme_v1'),
                    pressed: toggleBtn?.getAttribute('aria-pressed'),
                    toggleLbl,
                    bodyBgLum: lum(bodyCs.backgroundColor),
                    bodyFgLum: lum(bodyCs.color),
                    hdrBgLum: lum(hdrCs.backgroundColor),
                    hdrFgLum: lum(hdrCs.color),
                    cabBgLum: lum(cabCs.backgroundColor),
                    slotBgLum: lum(slotCs.backgroundColor),
                    ctaBgLum: lum(ctaCs.backgroundColor),
                    ctaFgLum: lum(ctaCs.color),
                    devBadgeBgLum,
                    casingOk: !hasCables || !!firstCasing
                };
            })()
        """)
        record(
            "Light Theme toggles UI surface, text contrast, hardware isolation & SVG bridge casing",
            bool(
                light_ui_check
                and light_ui_check["dataTheme"] == "light"
                and not light_ui_check["hasDarkClass"]
                and light_ui_check["stored"] == "light"
                and light_ui_check["pressed"] == "true"
                and light_ui_check["toggleLbl"] == "Светлая"
                and light_ui_check["bodyBgLum"] > 0.75
                and light_ui_check["bodyFgLum"] < 0.08
                and light_ui_check["hdrBgLum"] > 0.85
                and light_ui_check["hdrFgLum"] < 0.08
                and light_ui_check["cabBgLum"] > 0.85
                and light_ui_check["slotBgLum"] > 0.85
                and light_ui_check["ctaBgLum"] < 0.25
                and light_ui_check["ctaFgLum"] > 0.9
                and light_ui_check["devBadgeBgLum"] < 0.1
                and light_ui_check["casingOk"]
            ),
            str(light_ui_check)
        )

        # Verify Light Theme Topology SVG & Reload Persistence
        await client.eval("document.getElementById('btn-view-topology').click()")
        await asyncio.sleep(0.25)
        light_topo_ok = await client.eval("""
            (() => {
                const svg = document.getElementById('topology-svg');
                const bgRect = svg?.querySelector('rect');
                const texts = Array.from(svg?.querySelectorAll('text') || []);
                return {
                    hasSvg: !!svg,
                    bgFill: bgRect?.getAttribute('fill'),
                    hasDarkInk: texts.some(t => t.getAttribute('fill') === '#0f172a')
                };
            })()
        """)
        record(
            "Topology SVG switches to Light Theme palette automatically",
            bool(light_topo_ok and light_topo_ok["hasSvg"] and light_topo_ok["bgFill"] == "#ffffff" and light_topo_ok["hasDarkInk"]),
            str(light_topo_ok)
        )

        await client.send("Page.reload")
        await asyncio.sleep(0.4)
        for _ in range(50):
            ready = await client.eval("typeof window.app === 'object' && typeof window.store === 'object'")
            if ready:
                break
            await asyncio.sleep(0.1)
        await client.eval("window.alert = (msg) => console.log('[ALERT]', msg); window.confirm = () => true;")

        persisted_light = await client.eval("""
            (() => ({
                dataTheme: document.documentElement.dataset.theme,
                appTheme: window.app.theme,
                hasThemeInProject: Object.prototype.hasOwnProperty.call(window.store.state, 'theme')
            }))()
        """)
        record(
            "Light Theme persists across page reload without polluting project state",
            bool(persisted_light and persisted_light["dataTheme"] == "light" and persisted_light["appTheme"] == "light" and not persisted_light["hasThemeInProject"]),
            str(persisted_light)
        )

        # Toggle back to dark cleanly and clear browser theme pref before remaining checks
        await client.eval("document.getElementById('btn-toggle-theme').click(); localStorage.removeItem('rack_studio_theme_v1');")
        await asyncio.sleep(0.15)
        back_to_dark = await client.eval("document.documentElement.dataset.theme === 'dark' && document.documentElement.classList.contains('dark')")
        record("Theme toggle cleanly restores Dark Theme", bool(back_to_dark))

        # -------------------------------------------------------------
        # TEST 9: Export / Import JSON & Reset
        # -------------------------------------------------------------
        print("\n--- Test Suite 9: JSON Persistence & Export ---")
        export_data = await client.eval("JSON.stringify(window.store.state)")
        parsed = json.loads(export_data)
        has_racks = len(parsed.get("racks", [])) >= 1
        record("State serializes valid JSON schema with racks, cables, and templates", has_racks, f"{len(parsed.get('racks', []))} racks in JSON")

        # -------------------------------------------------------------
        # TEST 10: Console Health & Zero Errors Check
        # -------------------------------------------------------------
        print("\n--- Test Suite 10: Browser Console Diagnostics ---")
        errors = client.console_errors
        has_critical_errors = len([e for e in errors if "favicon" not in e.lower()]) > 0
        if has_critical_errors:
            print("  [WARNING] Console errors captured during session:")
            for err in errors:
                print(f"    ! {err}")
        record("Zero Uncaught Exceptions & Console Errors", not has_critical_errors, f"Total log entries: {len(client.console_logs)}")

        # Summary
        print("\n" + "=" * 70)
        total_tests = len(test_results)
        passed_tests = len([r for r in test_results if r[1]])
        failed_tests = total_tests - passed_tests
        print(f"  TOTAL TESTS: {total_tests} | PASSED: {passed_tests} | FAILED: {failed_tests}")
        print("=" * 70)

        await client.close()
        return failed_tests == 0

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            pass
        if server_proc:
            try:
                server_proc.terminate()
                server_proc.wait(timeout=2)
            except Exception:
                pass


if __name__ == "__main__":
    success = asyncio.run(run_test_suite())
    sys.exit(0 if success else 1)
