"""
Broker postback (webhook) receiver for real-time order updates.

This deployment is Shoonya-only and receives real-time order updates over
Shoonya's dedicated order WebSocket adapter (broker/shoonya/streaming/
shoonya_order_adapter.py). The /postback/<broker> route is kept as a safe
stub so CSRF exemptions and route references continue to resolve cleanly.
"""

from flask import Blueprint, jsonify

postback_bp = Blueprint("postback_bp", __name__, url_prefix="/postback")

SUPPORTED_BROKERS: set[str] = set()


@postback_bp.route("/<broker>", methods=["POST"])
def broker_postback(broker: str):
    broker = (broker or "").lower()
    return jsonify({"status": "error", "message": f"Unsupported broker: {broker}"}), 404
