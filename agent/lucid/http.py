"""Extra routes on the LangGraph server: what the head model computes, for the dashboard's simulation detail view."""

import threading

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.routing import Route

from lucid import physics

_solver = threading.Lock()  # the pyEIT model holds one assembled system at a time


async def mesh(_request):
    """The head mesh: nodes, triangles, tissue per triangle, electrode pair per scan spot."""
    return JSONResponse(await run_in_threadpool(physics.mesh_geometry), headers={"Cache-Control": "max-age=3600"})


async def sim(request):
    """One hypothesis solved live with pyEIT: blood, conductivity, the potential change per spot, and the readings."""
    hid = request.path_params["hypothesis_id"]
    try:
        h = physics.parse_hypothesis_id(hid)
    except ValueError:
        return JSONResponse({"error": f"unknown hypothesis '{hid}'"}, status_code=404)

    def solve() -> dict:
        with _solver:
            return {
                **h,
                **physics.field(h["type"], h["region"], h["volume_ml"]),
                "reading": physics.forward(h["type"], h["region"], h["volume_ml"]),
                "healthy": physics.null_reading(),
                "spots": physics.SPOT_NAMES,
            }

    return JSONResponse(await run_in_threadpool(solve))


app = Starlette(routes=[Route("/lucid/mesh", mesh), Route("/lucid/sim/{hypothesis_id}", sim)])
