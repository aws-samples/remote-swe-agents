from typing import Optional

from crhelper import CfnResource
import logging
import boto3

logger = logging.getLogger(__name__)

helper = CfnResource(json_logging=False, log_level='DEBUG', boto_level='CRITICAL', sleep_on_delete=120, ssl_verify=None)

client = boto3.client('bedrock-agentcore-control', region_name='us-east-1')

def find_agent_runtime_id(target_arn) -> Optional[str]:
    agent_runtimes = client.list_agent_runtimes()
    print(agent_runtimes)

    agent_runtimes = agent_runtimes.get('agentRuntimes', [])

    matching_runtime = next(
        (runtime for runtime in agent_runtimes
         if runtime['agentRuntimeArn'] == target_arn),
        None
    )

    return matching_runtime['agentRuntimeId'] if matching_runtime else None

def conform_name(name: str) -> str:
    # If empty or None, raise exception
    if not name:
        raise ValueError("Name cannot be empty")

    # Convert to string if not already
    name = str(name)

    # Replace any character that's not alphanumeric or underscore with underscore
    name = ''.join(c if c.isalnum() or c == '_' else '_' for c in name)

    # Ensure it starts with a letter
    if not name[0].isalpha():
        name = 'a' + name

    # Truncate to maximum length
    name = name[:48]

    return name


@helper.create
def create(event, context):
    logger.info(f"Received event: {event}")

    name = conform_name(event['LogicalResourceId'])
    container_uri = event['ResourceProperties']['ContainerUri']
    role_arn = event['ResourceProperties']['RoleArn']
    server_protocol = event['ResourceProperties']['ServerProtocol']
    authorizerConfiguration = event['ResourceProperties'].get('AuthorizerConfiguration', None)
    env = event['ResourceProperties'].get('Env', {})

    response = client.create_agent_runtime(
        agentRuntimeName=name,
        agentRuntimeArtifact={
            'containerConfiguration': {
                'containerUri': container_uri
            }
        },
        protocolConfiguration={
            'serverProtocol': server_protocol
        },
        networkConfiguration={
            "networkMode":"PUBLIC"
        },
        roleArn=role_arn,
        **({} if authorizerConfiguration is None else {"authorizerConfiguration": authorizerConfiguration}),
        environmentVariables=env,
    )

    print(response)

    # todo: use status

    # {
    #     'agentRuntimeArn': 'string',
    #     'workloadIdentityDetails': {
    #         'workloadIdentityArn': 'string'
    #     },
    #     'agentRuntimeId': 'string',
    #     'agentRuntimeVersion': 'string',
    #     'createdAt': datetime(2015, 1, 1),
    #     'status': 'CREATING'|'CREATE_FAILED'|'UPDATING'|'UPDATE_FAILED'|'READY'|'DELETING'
    # }

    return response['agentRuntimeArn']

@helper.update
def update(event, context):
    logger.info(f"Received event: {event}")

    resource_id = event['PhysicalResourceId']

    maybe_agent_runtime_id = find_agent_runtime_id(resource_id)

    if maybe_agent_runtime_id is None:
        raise Exception(f"Could not find agent runtime with id {resource_id}")

    container_uri = event['ResourceProperties']['ContainerUri']
    role_arn = event['ResourceProperties']['RoleArn']
    server_protocol = event['ResourceProperties']['ServerProtocol']
    authorizerConfiguration = event['ResourceProperties'].get('AuthorizerConfiguration', None)
    env = event['ResourceProperties'].get('Env', {})

    response = client.update_agent_runtime(
        agentRuntimeId=maybe_agent_runtime_id,
        agentRuntimeArtifact={
            'containerConfiguration': {
                'containerUri': container_uri
            }
        },
        roleArn=role_arn,
        networkConfiguration={
            'networkMode': 'PUBLIC'
        },
        protocolConfiguration={
            'serverProtocol': server_protocol
        },
        **({} if authorizerConfiguration is None else {"authorizerConfiguration": authorizerConfiguration}),
        environmentVariables=env,
    )

    print(response)

    # todo: use status

    return response['agentRuntimeArn']

@helper.delete
def delete(event, context):
    logger.info(f"Received event: {event}")

    resource_id = event['PhysicalResourceId']

    maybe_agent_runtime_id = find_agent_runtime_id(resource_id)

    client.delete_agent_runtime(agentRuntimeId=maybe_agent_runtime_id) if maybe_agent_runtime_id else None

    # todo: handle status
    # 'status': 'CREATING'|'CREATE_FAILED'|'UPDATING'|'UPDATE_FAILED'|'READY'|'DELETING'


def handler(event, context):
    helper(event, context)
